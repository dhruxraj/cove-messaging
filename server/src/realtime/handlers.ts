import type { IncomingMessage } from 'node:http';
import { parse as parseCookie } from 'hono/utils/cookie';
import { resolveSession, sessionCookieName } from '../auth/sessions';
import type { AppContext } from '../context';
import { isUuid } from '../lib/crypto';
import { log } from '../lib/log';
import type { HubHooks, RealtimeClient } from './hub';

interface TypingCacheEntry {
  peerId: string | null;
  allowed: boolean;
  at: number;
  lastSent: number;
}

/** Live presence: tell each contact who is allowed to know that this user came online/offline. */
async function broadcastPresence(ctx: AppContext, userId: string, online: boolean) {
  const me = await ctx.db.one<{ online_status: string; last_seen: string; last_seen_at: Date | null }>(
    `SELECT s.online_status, s.last_seen, u.last_seen_at FROM user_privacy_settings s JOIN users u ON u.id = s.user_id WHERE s.user_id = $1`,
    [userId],
  );
  if (!me) return;
  const contacts = await ctx.db.query<{ contact_id: string; contact_last_seen: string; blocked: boolean }>(
    `SELECT DISTINCT o.user_id AS contact_id, cs.last_seen AS contact_last_seen,
            EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = $1 AND b.blocked_id = o.user_id) OR (b.blocker_id = o.user_id AND b.blocked_id = $1)) AS blocked
     FROM conversation_participants mine
     JOIN conversation_participants o ON o.conversation_id = mine.conversation_id AND o.user_id <> mine.user_id
     JOIN user_privacy_settings cs ON cs.user_id = o.user_id
     WHERE mine.user_id = $1`,
    [userId],
  );
  for (const c of contacts.rows) {
    if (c.blocked) continue;
    const onlineVisible = me.online_status !== 'nobody';
    const lastSeenVisible = me.last_seen !== 'nobody' && c.contact_last_seen !== 'nobody';
    if (!onlineVisible && !lastSeenVisible) continue;
    ctx.hub.emitToUser(c.contact_id, 'presence', {
      userId,
      online: onlineVisible ? online : null,
      lastSeenAt: !online && lastSeenVisible && me.last_seen_at ? me.last_seen_at.toISOString() : null,
    });
  }
}

export function realtimeHooks(ctx: AppContext): HubHooks {
  const typingCache = new WeakMap<RealtimeClient, Map<string, TypingCacheEntry>>();

  async function handleTyping(client: RealtimeClient, conversationId: unknown, typing: unknown) {
    if (!isUuid(conversationId)) return;
    let cache = typingCache.get(client);
    if (!cache) typingCache.set(client, (cache = new Map()));
    const now = Date.now();
    let entry = cache.get(conversationId);
    if (!entry || now - entry.at > 60_000) {
      const r = await ctx.db.one<{ peer_id: string | null; blocked: boolean }>(
        `SELECT o.user_id AS peer_id,
                EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = $2 AND b.blocked_id = o.user_id) OR (b.blocker_id = o.user_id AND b.blocked_id = $2)) AS blocked
         FROM conversation_participants me
         LEFT JOIN conversation_participants o ON o.conversation_id = me.conversation_id AND o.user_id <> me.user_id
         WHERE me.conversation_id = $1 AND me.user_id = $2`,
        [conversationId, client.userId],
      );
      entry = { peerId: r?.peer_id ?? null, allowed: !!r && !r.blocked, at: now, lastSent: 0 };
      cache.set(conversationId, entry);
      if (cache.size > 50) cache.delete(cache.keys().next().value!);
    }
    if (!entry.allowed || !entry.peerId) return;
    const isTyping = typing === true;
    // At most one "typing" event per second per conversation; "stopped" always goes through.
    if (isTyping && now - entry.lastSent < 1000) return;
    entry.lastSent = isTyping ? now : 0;
    ctx.hub.emitToUser(entry.peerId, 'typing', { conversationId, userId: client.userId, typing: isTyping });
  }

  return {
    async authenticate(req: IncomingMessage) {
      const cookies = parseCookie(req.headers.cookie ?? '');
      const session = await resolveSession(ctx, cookies[sessionCookieName(ctx.cfg)]);
      return session ? { userId: session.userId, sessionId: session.sessionId } : null;
    },
    async validSessions(ids: string[]) {
      const r = await ctx.db.query<{ id: string }>(
        `SELECT id FROM sessions WHERE id = ANY($1::uuid[]) AND revoked_at IS NULL AND expires_at > now()
           AND last_active_at > now() - make_interval(days => $2)`,
        [ids, ctx.cfg.SESSION_IDLE_DAYS],
      );
      return new Set(r.rows.map((x) => x.id));
    },
    onFirstConnection(userId: string) {
      void broadcastPresence(ctx, userId, true).catch((err) => log.warn('presence broadcast failed', { err }));
    },
    onLastDisconnect(userId: string) {
      void ctx.db
        .query('UPDATE users SET last_seen_at = now() WHERE id = $1', [userId])
        .then(() => broadcastPresence(ctx, userId, false))
        .catch((err) => log.warn('presence broadcast failed', { err }));
    },
    onClientMessage(client: RealtimeClient, msg: Record<string, unknown>) {
      if (msg.type === 'typing') void handleTyping(client, msg.conversationId, msg.typing).catch(() => {});
    },
  };
}
