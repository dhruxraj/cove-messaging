import { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext, HonoEnv } from '../context';
import { ApiError, badRequest, forbidden, notFound } from '../lib/errors';
import { body, query, zMessageId, zUuid } from '../lib/http';
import { isSingleEmoji } from '../lib/text';
import { MAX_ENVELOPE, requireEnvelope } from '../e2ee/keys';
import { keys } from '../media/storage';
import { blockState, requireParticipant } from '../users/access';
import { serializeMessage, VISIBLE_TO_VIEWER } from './serialize';
import { broadcastMessage, deliverNewMessage, loadMessageRows, markRead, peerOf, receiptsVisible, sendMessage } from './service';

export function messageRoutes(ctx: AppContext) {
  const app = new Hono<HonoEnv>();
  const { db, cfg } = ctx;

  /** A message the caller can see, with its conversation participation. */
  async function visibleMessage(userId: string, messageId: string) {
    const r = await db.query<{ conversation_id: string; sender_id: string | null; kind: string; created_at: Date; deleted_at: Date | null; age_min: number }>(
      `SELECT m.conversation_id, m.sender_id, m.kind, m.created_at, m.deleted_at, extract(epoch FROM now() - m.created_at) / 60 AS age_min
       FROM messages m JOIN conversation_participants vp ON vp.conversation_id = m.conversation_id AND vp.user_id = $1
       WHERE m.id = $2 AND ${VISIBLE_TO_VIEWER}`,
      [userId, messageId],
    );
    const m = r.rows[0];
    if (!m) throw notFound('Message not found.');
    return m;
  }

  app.get('/conversations/:id/messages', async (c) => {
    const { userId } = c.get('auth');
    const id = zUuid.parse(c.req.param('id'));
    const q = query(c, z.object({ before: zMessageId.optional(), after: zMessageId.optional(), around: zMessageId.optional(), limit: z.coerce.number().int().min(1).max(100).default(40) }));
    const part = await requireParticipant(db, id, userId);
    const receipts = await receiptsVisible(db, userId, part.peer_id);
    const base = `m.conversation_id = $2 AND ${VISIBLE_TO_VIEWER}`;
    let rows;
    let hasMoreBefore = false;
    let hasMoreAfter = false;
    if (q.around) {
      const half = Math.floor(q.limit / 2);
      const older = await loadMessageRows(db, userId, `${base} AND m.id <= $3`, [id, q.around], `ORDER BY m.id DESC LIMIT ${half + 1}`);
      const newer = await loadMessageRows(db, userId, `${base} AND m.id > $3`, [id, q.around], `ORDER BY m.id ASC LIMIT ${half + 1}`);
      hasMoreBefore = older.length > half;
      hasMoreAfter = newer.length > half;
      rows = [...older.slice(0, half).reverse(), ...newer.slice(0, half)];
    } else if (q.after) {
      const r = await loadMessageRows(db, userId, `${base} AND m.id > $3`, [id, q.after], `ORDER BY m.id ASC LIMIT ${q.limit + 1}`);
      hasMoreAfter = r.length > q.limit;
      rows = r.slice(0, q.limit);
    } else {
      const r = q.before
        ? await loadMessageRows(db, userId, `${base} AND m.id < $3`, [id, q.before], `ORDER BY m.id DESC LIMIT ${q.limit + 1}`)
        : await loadMessageRows(db, userId, base, [id], `ORDER BY m.id DESC LIMIT ${q.limit + 1}`);
      hasMoreBefore = r.length > q.limit;
      rows = r.slice(0, q.limit).reverse();
    }
    return c.json({ messages: rows.map((r) => serializeMessage(r, userId, receipts)), hasMoreBefore, hasMoreAfter });
  });

  app.post('/conversations/:id/messages', async (c) => {
    const { userId } = c.get('auth');
    const id = zUuid.parse(c.req.param('id'));
    const input = await body(
      c,
      z.object({ clientId: zUuid, body: z.string().max(20_000).optional(), attachmentId: zUuid.optional(), replyToId: zMessageId.optional() }),
    );
    await ctx.limiter.enforce(`send:${userId}`, 30, 10, "You're sending messages too quickly.");
    const result = await sendMessage(ctx, userId, id, input);
    if (!result.duplicate) await deliverNewMessage(ctx, id, result.id, userId);
    const rows = await loadMessageRows(db, userId, 'm.id = $2', [result.id]);
    const peer = await peerOf(db, id, userId);
    return c.json({ message: serializeMessage(rows[0]!, userId, await receiptsVisible(db, userId, peer)), duplicate: result.duplicate }, result.duplicate ? 200 : 201);
  });

  app.patch('/messages/:id', async (c) => {
    const { userId } = c.get('auth');
    const id = zMessageId.parse(c.req.param('id'));
    const input = await body(c, z.object({ body: z.string().max(MAX_ENVELOPE) }));
    const m = await visibleMessage(userId, id);
    if (m.sender_id !== userId) throw forbidden('You can only edit your own messages.');
    if (m.deleted_at) throw badRequest('This message was deleted.');
    if (m.kind === 'system') throw forbidden();
    if (m.age_min > cfg.MESSAGE_EDIT_WINDOW_MINUTES) throw new ApiError(403, 'edit_window_passed', `Messages can only be edited within ${cfg.MESSAGE_EDIT_WINDOW_MINUTES} minutes of sending.`);
    if (!input.body && m.kind === 'text') throw badRequest("Message can't be empty.");
    const peer = await peerOf(db, m.conversation_id, userId);
    if (!peer) throw forbidden('This conversation is no longer available.');
    const b = await blockState(db, userId, peer);
    if (b.aBlockedB || b.bBlockedA) throw forbidden("You can't edit messages in this conversation.");
    const text = await requireEnvelope(db, input.body, userId, peer);
    await db.query('UPDATE messages SET body = $2, edited_at = now() WHERE id = $1 AND body IS DISTINCT FROM $2', [id, text]);
    await broadcastMessage(ctx, m.conversation_id, id, 'message:updated');
    return c.json({ ok: true });
  });

  app.delete('/messages/:id', async (c) => {
    const { userId } = c.get('auth');
    const id = zMessageId.parse(c.req.param('id'));
    const scope = c.req.query('for') === 'everyone' ? 'everyone' : 'me';
    const m = await visibleMessage(userId, id);
    if (scope === 'me') {
      await db.query('INSERT INTO message_hidden (message_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, userId]);
      ctx.hub.emitToUser(userId, 'message:removed', { conversationId: m.conversation_id, messageId: id });
      return c.json({ ok: true });
    }
    if (m.sender_id !== userId) throw forbidden('You can only delete your own messages for everyone.');
    if (m.age_min > cfg.MESSAGE_DELETE_WINDOW_MINUTES) throw new ApiError(403, 'delete_window_passed', 'This message is too old to delete for everyone. You can still delete it for yourself.');
    await db.tx(async (client) => {
      await client.query(`UPDATE messages SET deleted_at = now(), body = '', edited_at = NULL WHERE id = $1`, [id]);
      await client.query('DELETE FROM message_reactions WHERE message_id = $1', [id]);
      // Removing the attachment row queues its bytes for deletion (trigger) and revokes every grant.
      await client.query('DELETE FROM attachments WHERE message_id = $1', [id]);
    });
    await broadcastMessage(ctx, m.conversation_id, id, 'message:updated');
    return c.json({ ok: true });
  });

  app.put('/messages/:id/reaction', async (c) => {
    const { userId } = c.get('auth');
    const id = zMessageId.parse(c.req.param('id'));
    const { emoji } = await body(c, z.object({ emoji: z.string().max(32) }));
    if (!isSingleEmoji(emoji)) throw badRequest('Reactions must be a single emoji.', 'invalid_emoji');
    const m = await visibleMessage(userId, id);
    if (m.deleted_at || m.kind === 'system') throw badRequest("You can't react to this message.");
    const peer = await peerOf(db, m.conversation_id, userId);
    if (peer) {
      const b = await blockState(db, userId, peer);
      if (b.aBlockedB || b.bBlockedA) throw forbidden("You can't react in this conversation.");
    }
    await ctx.limiter.enforce(`react:${userId}`, 60, 60);
    await db.query(
      `INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)
       ON CONFLICT (message_id, user_id) DO UPDATE SET emoji = EXCLUDED.emoji, created_at = now()`,
      [id, userId, emoji],
    );
    await broadcastMessage(ctx, m.conversation_id, id, 'message:updated');
    return c.json({ ok: true });
  });

  app.delete('/messages/:id/reaction', async (c) => {
    const { userId } = c.get('auth');
    const id = zMessageId.parse(c.req.param('id'));
    const m = await visibleMessage(userId, id);
    await db.query('DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2', [id, userId]);
    await broadcastMessage(ctx, m.conversation_id, id, 'message:updated');
    return c.json({ ok: true });
  });

  /**
   * Forward a message. Text is end-to-end encrypted, so the sender's device decrypts it and sends a
   * freshly encrypted envelope for each target conversation; the server copies any attachment.
   */
  app.post('/messages/:id/forward', async (c) => {
    const { userId } = c.get('auth');
    const id = zMessageId.parse(c.req.param('id'));
    const { targets } = await body(
      c,
      z.object({ targets: z.array(z.object({ conversationId: zUuid, clientId: zUuid, body: z.string().max(MAX_ENVELOPE).default('') })).min(1).max(5) }),
    );
    const m = await visibleMessage(userId, id);
    if (m.deleted_at || m.kind === 'system') throw badRequest("This message can't be forwarded.");
    const src = await db.one<{ a_id: string | null; view_policy: string | null; storage_key: string | null; thumb_key: string | null; purged: boolean; has_grant: boolean }>(
      `SELECT a.id AS a_id, a.view_policy, a.storage_key, a.thumb_key, a.purged_at IS NOT NULL AS purged,
              EXISTS (SELECT 1 FROM media_access_grants g WHERE g.attachment_id = a.id AND g.user_id = $2) AS has_grant
       FROM messages m LEFT JOIN attachments a ON a.message_id = m.id WHERE m.id = $1`,
      [id, userId],
    );
    if (!src) throw notFound('Message not found.');
    if (src.a_id && src.view_policy !== 'normal') throw badRequest("View-once media can't be forwarded.", 'cannot_forward_protected');
    if (src.a_id && (src.purged || !src.has_grant)) throw badRequest('This media is no longer available.');
    await ctx.limiter.enforce(`forward:${userId}`, 30, 600, "You're forwarding too quickly.");

    const sent: string[] = [];
    const seen = new Set<string>();
    for (const t of targets) {
      if (seen.has(t.conversationId)) continue;
      seen.add(t.conversationId);
      const target = t.conversationId;
      // A retried forward (same clientId) is answered from the first attempt without copying again.
      const already = await db.one<{ id: string }>('SELECT id::text FROM messages WHERE sender_id = $1 AND client_id = $2', [userId, t.clientId]);
      if (already) {
        sent.push(target);
        continue;
      }
      let attachmentId: string | undefined;
      if (src.a_id) {
        await requireParticipant(db, target, userId);
        // Each forwarded copy gets its own stored object and grants.
        const newKey = keys.media();
        const newThumb = src.thumb_key ? keys.thumb() : null;
        await ctx.storage.copy(src.storage_key!, newKey);
        if (newThumb) await ctx.storage.copy(src.thumb_key!, newThumb);
        const a = await db.one<{ id: string }>(
          `INSERT INTO attachments (uploader_id, conversation_id, kind, mime, file_name, size_bytes, sha256, width, height, duration_ms, storage_key, thumb_key, view_policy)
           SELECT $2, $3, kind, mime, file_name, size_bytes, sha256, width, height, duration_ms, $4, $5, 'normal' FROM attachments WHERE id = $1
           RETURNING id`,
          [src.a_id, userId, target, newKey, newThumb],
        );
        attachmentId = a!.id;
      }
      try {
        const res = await sendMessage(ctx, userId, target, { clientId: t.clientId, body: t.body, attachmentId, forwarded: true });
        if (!res.duplicate) await deliverNewMessage(ctx, target, res.id, userId);
        sent.push(target);
      } catch (err) {
        if (attachmentId) await db.query('DELETE FROM attachments WHERE id = $1 AND message_id IS NULL', [attachmentId]);
        if (targets.length === 1) throw err;
      }
    }
    return c.json({ ok: true, forwardedTo: sent });
  });

  app.post('/conversations/:id/read', async (c) => {
    const { userId } = c.get('auth');
    const id = zUuid.parse(c.req.param('id'));
    const { messageId } = await body(c, z.object({ messageId: zMessageId }));
    const lastRead = await markRead(ctx, userId, id, messageId);
    return c.json({ lastReadMessageId: lastRead });
  });

  return app;
}
