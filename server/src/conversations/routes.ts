import { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext, HonoEnv } from '../context';
import { uuid } from '../lib/crypto';
import { ApiError, badRequest, notFound } from '../lib/errors';
import { body, zUuid } from '../lib/http';
import { MAX_NOTE_ENVELOPE, requireEnvelope } from '../e2ee/keys';
import { broadcastMessage, insertSystemMessage, markDeliveredForUser, participantsOf } from '../messages/service';
import { notify } from '../notifications/service';
import { blockState, directKey, requireParticipant } from '../users/access';
import { publicProfiles } from '../users/profiles';
import { conversationSummary, ensureDirectConversation, listConversations } from './service';

interface RequestRow {
  id: string;
  requester_id: string;
  recipient_id: string;
  note: string;
  status: 'pending' | 'accepted' | 'rejected' | 'cancelled';
  conversation_id: string | null;
  created_at: Date;
}

export function conversationRoutes(ctx: AppContext) {
  const app = new Hono<HonoEnv>();
  const { db } = ctx;

  const serializeRequest = async (viewerId: string, r: RequestRow) => {
    const other = r.requester_id === viewerId ? r.recipient_id : r.requester_id;
    const profile = (await publicProfiles(ctx, viewerId, [other])).get(other);
    const outgoing = r.requester_id === viewerId;
    return {
      id: r.id,
      direction: outgoing ? 'outgoing' : 'incoming',
      // Requesters are never told that a request was declined.
      status: outgoing && r.status === 'rejected' ? 'pending' : r.status,
      note: r.note,
      createdAt: r.created_at.toISOString(),
      conversationId: r.conversation_id,
      user: profile,
    };
  };

  const announceConversation = async (conversationId: string) => {
    for (const uid of await participantsOf(db, conversationId)) {
      const summary = await conversationSummary(ctx, uid, conversationId);
      if (summary) ctx.hub.emitToUser(uid, 'conversation:updated', { conversation: summary });
    }
  };

  app.get('/conversations', async (c) => {
    const { userId } = c.get('auth');
    // Fetching the list is how a client syncs, so everything addressed to it is now delivered.
    await markDeliveredForUser(ctx, userId);
    return c.json({ conversations: await listConversations(ctx, userId) });
  });

  app.get('/conversations/:id', async (c) => {
    const { userId } = c.get('auth');
    const id = zUuid.parse(c.req.param('id'));
    await requireParticipant(db, id, userId);
    return c.json({ conversation: await conversationSummary(ctx, userId, id) });
  });

  /** Start a chat with someone, or send them a request depending on their privacy setting. */
  app.post('/conversations', async (c) => {
    const { userId } = c.get('auth');
    const input = await body(c, z.object({ userId: zUuid, note: z.string().max(MAX_NOTE_ENVELOPE).optional() }));
    const targetId = input.userId;
    if (targetId === userId) throw badRequest("You can't start a conversation with yourself.");
    const target = await db.one<{ who_can_message: string; setup: boolean }>(
      `SELECT s.who_can_message, p.setup_completed_at IS NOT NULL AS setup FROM users u
       JOIN user_profiles p ON p.user_id = u.id JOIN user_privacy_settings s ON s.user_id = u.id WHERE u.id = $1`,
      [targetId],
    );
    if (!target?.setup) throw notFound('User not found.');
    const blocks = await blockState(db, userId, targetId);
    if (blocks.aBlockedB) throw new ApiError(403, 'you_blocked', 'Unblock this person to start a conversation.');
    if (blocks.bBlockedA) throw new ApiError(403, 'unavailable', "You can't start a conversation with this person.");

    const existing = await db.one<{ id: string }>('SELECT id FROM conversations WHERE direct_key = $1', [directKey(userId, targetId)]);
    if (existing) {
      await db.query(
        `INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2) ON CONFLICT (conversation_id, user_id) DO UPDATE SET hidden_at = NULL`,
        [existing.id, userId],
      );
      return c.json({ conversation: await conversationSummary(ctx, userId, existing.id) });
    }

    // The optional note is end-to-end encrypted to the recipient (it becomes the first message).
    const note = await requireEnvelope(db, input.note ?? '', userId, targetId, MAX_NOTE_ENVELOPE);
    await ctx.limiter.enforce(`new-conversation:${userId}`, 50, 86400, "You've started many conversations today. Try again tomorrow.");
    const myTtl = (await db.one<{ t: number | null }>('SELECT default_message_ttl_seconds AS t FROM user_privacy_settings WHERE user_id = $1', [userId]))?.t ?? null;

    // If they already asked to talk to us, starting a chat accepts their request.
    const theirs = await db.one<RequestRow>(`SELECT * FROM conversation_requests WHERE requester_id = $1 AND recipient_id = $2 AND status = 'pending'`, [targetId, userId]);

    if (target.who_can_message === 'everyone' || theirs) {
      const conv = await db.tx(async (client) => {
        const conv = await ensureDirectConversation(client, userId, targetId, myTtl);
        if (theirs) await client.query(`UPDATE conversation_requests SET status = 'accepted', responded_at = now(), conversation_id = $2 WHERE id = $1`, [theirs.id, conv.id]);
        if (note) await client.query(`INSERT INTO messages (conversation_id, sender_id, client_id, kind, body) VALUES ($1, $2, $3, 'text', $4)`, [conv.id, userId, uuid(), note]);
        await client.query('UPDATE conversations SET last_message_at = now() WHERE id = $1', [conv.id]);
        return conv;
      });
      await announceConversation(conv.id);
      return c.json({ conversation: await conversationSummary(ctx, userId, conv.id) });
    }
    if (target.who_can_message === 'nobody') throw new ApiError(403, 'not_accepting', "This person isn't accepting new conversations.");

    const mine = await db.one<RequestRow>(`SELECT * FROM conversation_requests WHERE requester_id = $1 AND recipient_id = $2 AND status IN ('pending','rejected')`, [userId, targetId]);
    if (mine) return c.json({ request: await serializeRequest(userId, mine) });
    const created = await db.one<RequestRow>(
      `INSERT INTO conversation_requests (requester_id, recipient_id, note) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING RETURNING *`,
      [userId, targetId, note],
    );
    const row = created ?? (await db.one<RequestRow>(`SELECT * FROM conversation_requests WHERE requester_id = $1 AND recipient_id = $2 AND status IN ('pending','rejected')`, [userId, targetId]))!;
    if (created) {
      const serialized = await serializeRequest(targetId, created);
      await notify(ctx, targetId, 'conversation_request', { requestId: created.id, fromUserId: userId });
      ctx.hub.emitToUser(targetId, 'request:new', { request: serialized });
      void ctx.push.sendToUser(targetId, { title: ctx.cfg.APP_NAME, body: 'New message request', tag: 'cove-requests', url: '/requests' }).catch(() => {});
    }
    return c.json({ request: await serializeRequest(userId, row) });
  });

  app.patch('/conversations/:id', async (c) => {
    const { userId } = c.get('auth');
    const id = zUuid.parse(c.req.param('id'));
    const input = await body(
      c,
      z
        .object({
          archived: z.boolean(),
          muted: z.boolean(),
          messageTtlSeconds: z.union([z.literal(86400), z.literal(604800), z.literal(7776000), z.null()]),
          allowProtectedMedia: z.boolean().nullable(),
        })
        .partial()
        .strict(),
    );
    const part = await requireParticipant(db, id, userId);
    let systemMessageId: string | null = null;
    await db.tx(async (client) => {
      if (input.archived !== undefined) await client.query('UPDATE conversation_participants SET archived_at = CASE WHEN $3 THEN now() ELSE NULL END WHERE conversation_id = $1 AND user_id = $2', [id, userId, input.archived]);
      if (input.muted !== undefined) await client.query('UPDATE conversation_participants SET muted = $3 WHERE conversation_id = $1 AND user_id = $2', [id, userId, input.muted]);
      if (input.allowProtectedMedia !== undefined) await client.query('UPDATE conversation_participants SET allow_protected_media = $3 WHERE conversation_id = $1 AND user_id = $2', [id, userId, input.allowProtectedMedia]);
      if (input.messageTtlSeconds !== undefined && input.messageTtlSeconds !== part.message_ttl_seconds) {
        if (part.peer_id) {
          const b = await blockState(client, userId, part.peer_id);
          if (b.aBlockedB || b.bBlockedA) throw new ApiError(403, 'blocked', "You can't change this conversation's settings.");
        }
        await client.query('UPDATE conversations SET message_ttl_seconds = $2 WHERE id = $1', [id, input.messageTtlSeconds]);
        systemMessageId = await insertSystemMessage(client, id, { type: 'ttl_changed', actorId: userId, ttl: input.messageTtlSeconds });
      }
    });
    if (systemMessageId) {
      await broadcastMessage(ctx, id, systemMessageId, 'message:new');
      await announceConversation(id);
    } else {
      const summary = await conversationSummary(ctx, userId, id);
      ctx.hub.emitToUser(userId, 'conversation:updated', { conversation: summary });
    }
    return c.json({ conversation: await conversationSummary(ctx, userId, id) });
  });

  /** "Delete chat": removes the conversation and its history from the caller's account only. */
  app.delete('/conversations/:id', async (c) => {
    const { userId } = c.get('auth');
    const id = zUuid.parse(c.req.param('id'));
    await requireParticipant(db, id, userId);
    await db.query(
      `UPDATE conversation_participants SET hidden_at = now(), archived_at = NULL,
         cleared_before_message_id = (SELECT COALESCE(max(id), 0) FROM messages WHERE conversation_id = $1),
         last_read_message_id = GREATEST(last_read_message_id, (SELECT COALESCE(max(id), 0) FROM messages WHERE conversation_id = $1))
       WHERE conversation_id = $1 AND user_id = $2`,
      [id, userId],
    );
    ctx.hub.emitToUser(userId, 'conversation:removed', { conversationId: id });
    return c.json({ ok: true });
  });

  // ---- requests ----
  app.get('/conversation-requests', async (c) => {
    const { userId } = c.get('auth');
    const r = await db.query<RequestRow>(
      `SELECT r.* FROM conversation_requests r
       WHERE (r.recipient_id = $1 AND r.status = 'pending'
              AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = $1 AND b.blocked_id = r.requester_id))
          OR (r.requester_id = $1 AND r.status IN ('pending', 'rejected'))
       ORDER BY r.created_at DESC LIMIT 200`,
      [userId],
    );
    const items = await Promise.all(r.rows.map((x) => serializeRequest(userId, x)));
    return c.json({ incoming: items.filter((x) => x.direction === 'incoming'), outgoing: items.filter((x) => x.direction === 'outgoing') });
  });

  app.post('/conversation-requests/:id/:action{accept|reject|cancel}', async (c) => {
    const { userId } = c.get('auth');
    const id = zUuid.parse(c.req.param('id'));
    const action = c.req.param('action') as 'accept' | 'reject' | 'cancel';
    const result = await db.tx(async (client) => {
      const r = await client.query<RequestRow>(`SELECT * FROM conversation_requests WHERE id = $1 FOR UPDATE`, [id]);
      const req = r.rows[0];
      const isRecipient = req?.recipient_id === userId;
      const isRequester = req?.requester_id === userId;
      if (!req || (!isRecipient && !isRequester)) throw notFound('Request not found.');
      if (action === 'cancel') {
        if (!isRequester || !['pending', 'rejected'].includes(req.status)) throw notFound('Request not found.');
        await client.query(`UPDATE conversation_requests SET status = 'cancelled', responded_at = now() WHERE id = $1`, [id]);
        return { req, conversationId: null };
      }
      if (!isRecipient || req.status !== 'pending') throw notFound('Request not found.');
      if (action === 'reject') {
        await client.query(`UPDATE conversation_requests SET status = 'rejected', responded_at = now() WHERE id = $1`, [id]);
        return { req, conversationId: null };
      }
      const b = await blockState(client, userId, req.requester_id);
      if (b.aBlockedB || b.bBlockedA) throw new ApiError(403, 'blocked', 'This request can no longer be accepted.');
      const ttl = (await client.query<{ t: number | null }>('SELECT default_message_ttl_seconds AS t FROM user_privacy_settings WHERE user_id = $1', [req.requester_id])).rows[0]?.t ?? null;
      const conv = await ensureDirectConversation(client, req.requester_id, userId, ttl);
      await client.query(`UPDATE conversation_requests SET status = 'accepted', responded_at = now(), conversation_id = $2 WHERE id = $1`, [id, conv.id]);
      if (req.note) {
        await client.query(`INSERT INTO messages (conversation_id, sender_id, client_id, kind, body) VALUES ($1, $2, $3, 'text', $4)`, [conv.id, req.requester_id, uuid(), req.note]);
      }
      await client.query('UPDATE conversations SET last_message_at = now() WHERE id = $1', [conv.id]);
      await client.query('UPDATE conversation_participants SET hidden_at = NULL WHERE conversation_id = $1', [conv.id]);
      return { req, conversationId: conv.id };
    });
    if (result.conversationId) {
      await notify(ctx, result.req.requester_id, 'request_accepted', { conversationId: result.conversationId, byUserId: userId });
      await announceConversation(result.conversationId);
    }
    ctx.hub.emitToUser(userId, 'request:updated', { requestId: id, status: action === 'accept' ? 'accepted' : action === 'reject' ? 'rejected' : 'cancelled' });
    if (action === 'cancel') ctx.hub.emitToUser(result.req.recipient_id, 'request:updated', { requestId: id, status: 'cancelled' });
    return c.json({ ok: true, conversation: result.conversationId ? await conversationSummary(ctx, userId, result.conversationId) : null });
  });

  return app;
}
