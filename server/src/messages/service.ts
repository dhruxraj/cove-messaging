import type pg from 'pg';
import type { AppContext } from '../context';
import type { Queryable } from '../db';
import { isUuid } from '../lib/crypto';
import { ApiError, badRequest, forbidden, isUniqueViolation } from '../lib/errors';
import { requireEnvelope } from '../e2ee/keys';
import { log } from '../lib/log';
import { acceptsProtectedMedia, blockState, requireParticipant } from '../users/access';
import { MESSAGE_SELECT, previewText, serializeMessage, VISIBLE_TO_VIEWER, type MessageRow, type SerializedMessage } from './serialize';

export async function receiptsVisible(db: Queryable, a: string, b: string | null): Promise<boolean> {
  if (!b) return false;
  const r = await db.query<{ enabled: number }>(
    'SELECT count(*) FILTER (WHERE read_receipts)::int AS enabled FROM user_privacy_settings WHERE user_id = ANY($1::uuid[])',
    [[a, b]],
  );
  return r.rows[0]?.enabled === 2;
}

export async function loadMessageRows(db: Queryable, viewerId: string, where: string, params: unknown[], tail = ''): Promise<MessageRow[]> {
  const r = await db.query<MessageRow>(`${MESSAGE_SELECT} WHERE ${where} ${tail}`, [viewerId, ...params]);
  return r.rows;
}

/** One message as seen by `viewerId`, or null if they cannot see it. */
export async function messageForViewer(ctx: AppContext, viewerId: string, messageId: string, peerId?: string | null) {
  const rows = await loadMessageRows(ctx.db, viewerId, `m.id = $2 AND ${VISIBLE_TO_VIEWER}`, [messageId]);
  const row = rows[0];
  if (!row) return null;
  const peer = peerId === undefined ? await peerOf(ctx.db, row.conversation_id, viewerId) : peerId;
  return serializeMessage(row, viewerId, await receiptsVisible(ctx.db, viewerId, peer));
}

export async function peerOf(db: Queryable, conversationId: string, userId: string): Promise<string | null> {
  const r = await db.query<{ user_id: string }>(
    'SELECT user_id FROM conversation_participants WHERE conversation_id = $1 AND user_id <> $2 LIMIT 1',
    [conversationId, userId],
  );
  return r.rows[0]?.user_id ?? null;
}

export async function participantsOf(db: Queryable, conversationId: string): Promise<string[]> {
  const r = await db.query<{ user_id: string }>('SELECT user_id FROM conversation_participants WHERE conversation_id = $1', [conversationId]);
  return r.rows.map((x) => x.user_id);
}

/** Push a message (new or changed) to every participant, serialised for each of them. */
export async function broadcastMessage(ctx: AppContext, conversationId: string, messageId: string, event: 'message:new' | 'message:updated') {
  const users = await participantsOf(ctx.db, conversationId);
  const out: Record<string, SerializedMessage | null> = {};
  for (const uid of users) {
    const msg = await messageForViewer(ctx, uid, messageId, users.find((u) => u !== uid) ?? null);
    out[uid] = msg;
    if (msg) ctx.hub.emitToUser(uid, event, { message: msg });
  }
  return out;
}

export async function insertSystemMessage(client: pg.PoolClient, conversationId: string, event: Record<string, unknown>) {
  const r = await client.query<{ id: string }>(
    `INSERT INTO messages (conversation_id, sender_id, kind, system_event) VALUES ($1, NULL, 'system', $2) RETURNING id::text`,
    [conversationId, event],
  );
  await client.query('UPDATE conversations SET last_message_at = now() WHERE id = $1', [conversationId]);
  return r.rows[0]!.id;
}

export interface SendInput {
  clientId: string;
  body?: string;
  attachmentId?: string;
  replyToId?: string;
  forwarded?: boolean;
}

/**
 * Create a message. Idempotent per (sender, clientId): retrying after a network failure returns
 * the original message instead of a duplicate.
 */
export async function sendMessage(ctx: AppContext, senderId: string, conversationId: string, input: SendInput): Promise<{ id: string; duplicate: boolean }> {
  if (!isUuid(input.clientId)) throw badRequest('clientId must be a UUID.', 'invalid_client_id');
  // The body is an end-to-end encrypted envelope (or empty for media without a caption).
  const body = input.body ?? '';
  if (!body && !input.attachmentId) throw badRequest("Message can't be empty.", 'empty_message');

  const existing = await ctx.db.one<{ id: string }>('SELECT id::text FROM messages WHERE sender_id = $1 AND client_id = $2', [senderId, input.clientId]);
  if (existing) return { id: existing.id, duplicate: true };

  try {
    return await ctx.db.tx(async (client) => {
      const part = await requireParticipant(client, conversationId, senderId);
      if (!part.peer_id) throw forbidden('This conversation is no longer available.');
      const blocks = await blockState(client, senderId, part.peer_id);
      if (blocks.aBlockedB) throw new ApiError(403, 'you_blocked', 'Unblock this contact to send a message.');
      if (blocks.bBlockedA) throw new ApiError(403, 'cannot_deliver', "This message couldn't be delivered.");
      await requireEnvelope(client, body, senderId, part.peer_id);

      if (input.replyToId) {
        const ok = await client.query(
          `SELECT 1 FROM messages m WHERE m.id = $1 AND m.conversation_id = $2 AND m.id > $3 AND m.kind <> 'system'
             AND (m.expires_at IS NULL OR m.expires_at > now())`,
          [input.replyToId, conversationId, part.cleared_before_message_id],
        );
        if (!ok.rowCount) throw badRequest('The message you replied to is no longer available.', 'invalid_reply');
      }

      let kind = 'text';
      let att: { id: string; kind: string; view_policy: string } | undefined;
      if (input.attachmentId) {
        if (!isUuid(input.attachmentId)) throw badRequest('Invalid attachment.', 'invalid_attachment');
        const a = await client.query<{ id: string; kind: string; view_policy: string }>(
          `SELECT id, kind, view_policy FROM attachments
           WHERE id = $1 AND uploader_id = $2 AND conversation_id = $3 AND message_id IS NULL FOR UPDATE`,
          [input.attachmentId, senderId, conversationId],
        );
        att = a.rows[0];
        if (!att) throw badRequest('This attachment is no longer available. Please upload it again.', 'invalid_attachment');
        if (att.view_policy !== 'normal' && !(await acceptsProtectedMedia(client, conversationId, part.peer_id))) {
          throw new ApiError(403, 'protected_media_not_allowed', "This person doesn't accept view-once media.");
        }
        kind = att.kind;
      }

      const ttl = part.message_ttl_seconds;
      const m = await client.query<{ id: string }>(
        `INSERT INTO messages (conversation_id, sender_id, client_id, kind, body, reply_to_id, forwarded, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $8::int IS NULL THEN NULL ELSE now() + make_interval(secs => $8::int) END)
         RETURNING id::text`,
        [conversationId, senderId, input.clientId, kind, body, input.replyToId ?? null, !!input.forwarded, ttl],
      );
      const messageId = m.rows[0]!.id;

      if (att) {
        await client.query(
          `UPDATE attachments SET message_id = $2,
             expires_at = CASE WHEN view_policy <> 'normal'
               THEN LEAST(now() + make_interval(days => $3), COALESCE((SELECT expires_at FROM messages WHERE id = $2), 'infinity'))
               ELSE NULL END
           WHERE id = $1`,
          [att.id, messageId, ctx.cfg.PROTECTED_MEDIA_TTL_DAYS],
        );
        const limit = att.view_policy === 'once' ? 1 : att.view_policy === 'twice' ? 2 : null;
        // The sender keeps access to normal media only. View-once media is for the recipient alone.
        if (att.view_policy === 'normal') {
          await client.query('INSERT INTO media_access_grants (attachment_id, user_id, view_limit) VALUES ($1, $2, NULL)', [att.id, senderId]);
        }
        await client.query('INSERT INTO media_access_grants (attachment_id, user_id, view_limit) VALUES ($1, $2, $3)', [att.id, part.peer_id, limit]);
      }
      await client.query('UPDATE conversations SET last_message_at = now() WHERE id = $1', [conversationId]);
      await client.query('UPDATE conversation_participants SET hidden_at = NULL WHERE conversation_id = $1', [conversationId]);
      return { id: messageId, duplicate: false };
    });
  } catch (err) {
    if (isUniqueViolation(err, 'messages_sender_client_key')) {
      const again = await ctx.db.one<{ id: string }>('SELECT id::text FROM messages WHERE sender_id = $1 AND client_id = $2', [senderId, input.clientId]);
      if (again) return { id: again.id, duplicate: true };
    }
    throw err;
  }
}

/** Fan out a freshly created message; record delivery when the recipient's client acknowledges it. */
export async function deliverNewMessage(ctx: AppContext, conversationId: string, messageId: string, senderId: string) {
  const users = await participantsOf(ctx.db, conversationId);
  const recipient = users.find((u) => u !== senderId) ?? null;
  const senderView = await messageForViewer(ctx, senderId, messageId, recipient);
  if (senderView) ctx.hub.emitToUser(senderId, 'message:new', { message: senderView });
  if (!recipient) return;
  const recipientView = await messageForViewer(ctx, recipient, messageId, senderId);
  if (!recipientView) return;

  const wantsPush = !ctx.hub.hasVisibleClient(recipient);
  void ctx.hub.emitToUserWithAck(recipient, 'message:new', { message: recipientView }).then(async (acked) => {
    if (!acked) return;
    const r = await ctx.db.query('UPDATE messages SET delivered_at = now() WHERE id = $1 AND delivered_at IS NULL RETURNING id', [messageId]);
    if (r.rowCount) ctx.hub.emitToUser(senderId, 'message:status', { conversationId, messageIds: [messageId], status: 'delivered' });
  }).catch((err) => log.warn('delivery ack handling failed', { err }));

  if (wantsPush) void sendMessagePush(ctx, recipient, senderId, conversationId, recipientView).catch((err) => log.warn('push failed', { err }));
}

async function sendMessagePush(ctx: AppContext, recipient: string, senderId: string, conversationId: string, msg: SerializedMessage) {
  if (!ctx.push.enabled) return;
  const prefs = await ctx.db.one<{ push_enabled: boolean; push_show_preview: boolean; muted: boolean; sender_name: string | null }>(
    `SELECT n.push_enabled, n.push_show_preview, p.muted,
            (SELECT display_name FROM user_profiles WHERE user_id = $3) AS sender_name
     FROM user_notification_settings n
     JOIN conversation_participants p ON p.user_id = n.user_id AND p.conversation_id = $2
     WHERE n.user_id = $1`,
    [recipient, conversationId, senderId],
  );
  if (!prefs?.push_enabled || prefs.muted) return;
  // Message text is end-to-end encrypted, so a push can never contain it. With "show sender" on,
  // the notification names the sender and the kind of message; otherwise it is fully generic.
  const viewPolicy = (msg.attachment as { viewPolicy?: string } | null)?.viewPolicy ?? null;
  const label = msg.kind === 'text' ? 'New message' : previewText(msg.kind, viewPolicy, false);
  const payload = prefs.push_show_preview
    ? { title: prefs.sender_name ?? ctx.cfg.APP_NAME, body: label, tag: conversationId, url: `/c/${conversationId}` }
    : { title: ctx.cfg.APP_NAME, body: 'New message', tag: 'cove-messages', url: `/c/${conversationId}` };
  await ctx.push.sendToUser(recipient, payload);
}

/** Mark everything addressed to `userId` as delivered (called when their client syncs). */
export async function markDeliveredForUser(ctx: AppContext, userId: string) {
  const r = await ctx.db.query<{ id: string; conversation_id: string; sender_id: string }>(
    `UPDATE messages m SET delivered_at = now()
     FROM conversation_participants p
     WHERE p.user_id = $1 AND m.conversation_id = p.conversation_id
       AND m.delivered_at IS NULL AND m.sender_id IS NOT NULL AND m.sender_id <> $1
     RETURNING m.id::text, m.conversation_id, m.sender_id`,
    [userId],
  );
  const groups = new Map<string, { sender: string; conversationId: string; ids: string[] }>();
  for (const row of r.rows) {
    const k = `${row.sender_id}|${row.conversation_id}`;
    const g = groups.get(k) ?? { sender: row.sender_id, conversationId: row.conversation_id, ids: [] };
    g.ids.push(row.id);
    groups.set(k, g);
  }
  for (const g of groups.values()) ctx.hub.emitToUser(g.sender, 'message:status', { conversationId: g.conversationId, messageIds: g.ids, status: 'delivered' });
}

/** Advance the reader's position; send read receipts only when both people have them enabled. */
export async function markRead(ctx: AppContext, userId: string, conversationId: string, upToId: string) {
  const part = await requireParticipant(ctx.db, conversationId, userId);
  const visible = await receiptsVisible(ctx.db, userId, part.peer_id);
  const result = await ctx.db.tx(async (client) => {
    const p = await client.query<{ last_read_message_id: string }>(
      `UPDATE conversation_participants SET last_read_message_id = GREATEST(last_read_message_id,
         LEAST($3::bigint, (SELECT COALESCE(max(id), 0) FROM messages WHERE conversation_id = $1)))
       WHERE conversation_id = $1 AND user_id = $2 RETURNING last_read_message_id::text`,
      [conversationId, userId, upToId],
    );
    const lastRead = p.rows[0]!.last_read_message_id;
    const changed = await client.query<{ id: string; was_delivered: boolean }>(
      `UPDATE messages m SET delivered_at = COALESCE(m.delivered_at, now()),
              read_at = CASE WHEN $4 THEN COALESCE(m.read_at, now()) ELSE m.read_at END
       FROM (SELECT id, delivered_at IS NOT NULL AS was_delivered FROM messages
             WHERE conversation_id = $1 AND sender_id IS NOT NULL AND sender_id <> $2 AND id <= $3::bigint
               AND (delivered_at IS NULL OR ($4 AND read_at IS NULL))
             FOR UPDATE) old
       WHERE m.id = old.id
       RETURNING m.id::text, old.was_delivered`,
      [conversationId, userId, lastRead, visible],
    );
    return { lastRead, changed: changed.rows };
  });
  if (part.peer_id && result.changed.length) {
    if (visible) {
      ctx.hub.emitToUser(part.peer_id, 'message:status', { conversationId, messageIds: result.changed.map((x) => x.id), status: 'read' });
    } else {
      const newly = result.changed.filter((x) => !x.was_delivered).map((x) => x.id);
      if (newly.length) ctx.hub.emitToUser(part.peer_id, 'message:status', { conversationId, messageIds: newly, status: 'delivered' });
    }
  }
  ctx.hub.emitToUser(userId, 'conversation:read', { conversationId, lastReadMessageId: result.lastRead });
  return result.lastRead;
}
