import type pg from 'pg';
import type { AppContext } from '../context';
import { directKey } from '../users/access';
import { publicProfiles } from '../users/profiles';
import { previewText } from '../messages/serialize';

interface ConversationListRow {
  id: string;
  created_at: Date;
  last_message_at: Date | null;
  message_ttl_seconds: number | null;
  last_read_message_id: string;
  archived_at: Date | null;
  muted: boolean;
  allow_protected_media: boolean | null;
  peer_id: string | null;
  peer_accepts_protected: boolean | null;
  my_receipts: boolean;
  peer_receipts: boolean | null;
  lm_id: string | null;
  lm_sender_id: string | null;
  lm_kind: string | null;
  lm_body: string | null;
  lm_created_at: Date | null;
  lm_deleted_at: Date | null;
  lm_delivered_at: Date | null;
  lm_read_at: Date | null;
  lm_system_event: Record<string, unknown> | null;
  lm_view_policy: string | null;
  peer_kid: string | null;
  unread: number;
}

const LIST_SQL = `
  SELECT c.id, c.created_at, c.last_message_at, c.message_ttl_seconds,
         p.last_read_message_id::text, p.archived_at, p.muted, p.allow_protected_media,
         o.user_id AS peer_id,
         COALESCE(o.allow_protected_media, os.allow_protected_media) AS peer_accepts_protected,
         ms.read_receipts AS my_receipts, os.read_receipts AS peer_receipts,
         lm.id::text AS lm_id, lm.sender_id AS lm_sender_id, lm.kind AS lm_kind, lm.body AS lm_body, lm.created_at AS lm_created_at,
         lm.deleted_at AS lm_deleted_at, lm.delivered_at AS lm_delivered_at, lm.read_at AS lm_read_at,
         lm.system_event AS lm_system_event, lm.view_policy AS lm_view_policy,
         (SELECT k.kid FROM user_keys k WHERE k.user_id = o.user_id AND k.superseded_at IS NULL) AS peer_kid,
         (SELECT count(*)::int FROM (
            SELECT 1 FROM messages um
            WHERE um.conversation_id = c.id AND um.id > GREATEST(p.last_read_message_id, p.cleared_before_message_id)
              AND um.sender_id IS NOT NULL AND um.sender_id <> $1 AND um.deleted_at IS NULL
              AND (um.expires_at IS NULL OR um.expires_at > now())
              AND NOT EXISTS (SELECT 1 FROM message_hidden uh WHERE uh.user_id = $1 AND uh.message_id = um.id)
            LIMIT 100) u) AS unread
  FROM conversation_participants p
  JOIN conversations c ON c.id = p.conversation_id
  JOIN user_privacy_settings ms ON ms.user_id = p.user_id
  LEFT JOIN conversation_participants o ON o.conversation_id = c.id AND o.user_id <> p.user_id
  LEFT JOIN user_privacy_settings os ON os.user_id = o.user_id
  LEFT JOIN LATERAL (
    SELECT m.id, m.sender_id, m.kind, m.body, m.created_at, m.deleted_at, m.delivered_at, m.read_at, m.system_event, a.view_policy
    FROM messages m LEFT JOIN attachments a ON a.message_id = m.id
    WHERE m.conversation_id = c.id AND m.id > p.cleared_before_message_id
      AND (m.expires_at IS NULL OR m.expires_at > now())
      AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.user_id = $1 AND h.message_id = m.id)
    ORDER BY m.id DESC LIMIT 1
  ) lm ON true
  WHERE p.user_id = $1`;

export async function listConversations(ctx: AppContext, userId: string, opts: { conversationId?: string; includeHidden?: boolean } = {}) {
  const params: unknown[] = [userId];
  let where = '';
  if (opts.conversationId) {
    params.push(opts.conversationId);
    where += ` AND c.id = $${params.length}`;
  }
  if (!opts.includeHidden) where += ' AND p.hidden_at IS NULL';
  const r = await ctx.db.query<ConversationListRow>(`${LIST_SQL}${where} ORDER BY COALESCE(lm.created_at, c.created_at) DESC LIMIT 1000`, params);
  const profiles = await publicProfiles(ctx, userId, r.rows.map((x) => x.peer_id).filter((x): x is string => !!x));
  return r.rows.map((row) => {
    const receipts = row.my_receipts && !!row.peer_receipts;
    const mine = row.lm_sender_id === userId;
    return {
      id: row.id,
      peer: row.peer_id ? profiles.get(row.peer_id)! : null,
      createdAt: row.created_at.toISOString(),
      lastActivityAt: (row.lm_created_at ?? row.created_at).toISOString(),
      lastMessage: row.lm_id
        ? {
            id: row.lm_id,
            senderId: row.lm_sender_id,
            kind: row.lm_kind,
            preview: row.lm_kind === 'system' ? systemPreview(row.lm_system_event) : previewText(row.lm_kind!, row.lm_view_policy, !!row.lm_deleted_at),
            // End-to-end encrypted text (or caption); the client decrypts it for the list preview.
            body: row.lm_deleted_at || row.lm_kind === 'system' ? '' : (row.lm_body ?? ''),
            system: row.lm_kind === 'system' ? row.lm_system_event : null,
            viewPolicy: row.lm_view_policy,
            createdAt: row.lm_created_at!.toISOString(),
            deleted: !!row.lm_deleted_at,
            status: mine ? (row.lm_read_at && receipts ? 'read' : row.lm_delivered_at ? 'delivered' : 'sent') : undefined,
          }
        : null,
      unreadCount: row.unread,
      lastReadMessageId: row.last_read_message_id,
      archived: !!row.archived_at,
      muted: row.muted,
      messageTtlSeconds: row.message_ttl_seconds,
      allowProtectedMedia: row.allow_protected_media,
      peerAcceptsProtectedMedia: !!row.peer_accepts_protected,
      peerKeyId: row.peer_kid,
      readReceiptsActive: receipts,
    };
  });
}

export type ConversationSummary = Awaited<ReturnType<typeof listConversations>>[number];

export function systemPreview(ev: Record<string, unknown> | null): string {
  if (ev?.type === 'ttl_changed') {
    const ttl = ev.ttl as number | null;
    return ttl ? `Disappearing messages set to ${ttlLabel(ttl)}` : 'Disappearing messages turned off';
  }
  if (ev?.type === 'conversation_started') return 'Conversation started';
  if (ev?.type === 'key_changed') return 'Security code changed';
  return 'Update';
}

export const ttlLabel = (s: number) => (s === 86400 ? '24 hours' : s === 604800 ? '7 days' : s === 7776000 ? '90 days' : `${s}s`);

export async function conversationSummary(ctx: AppContext, userId: string, conversationId: string) {
  const list = await listConversations(ctx, userId, { conversationId, includeHidden: true });
  return list[0] ?? null;
}

/** Create the one-to-one conversation for a pair (or return the existing one). */
export async function ensureDirectConversation(client: pg.PoolClient, a: string, b: string, ttl: number | null): Promise<{ id: string; created: boolean }> {
  const key = directKey(a, b);
  const ins = await client.query<{ id: string }>(
    `INSERT INTO conversations (direct_key, message_ttl_seconds) VALUES ($1, $2) ON CONFLICT (direct_key) DO NOTHING RETURNING id`,
    [key, ttl],
  );
  if (ins.rows[0]) {
    const id = ins.rows[0].id;
    await client.query('INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2), ($1, $3)', [id, a, b]);
    await client.query(
      `INSERT INTO messages (conversation_id, sender_id, kind, system_event) VALUES ($1, NULL, 'system', $2)`,
      [id, { type: 'conversation_started' }],
    );
    return { id, created: true };
  }
  const existing = await client.query<{ id: string }>('SELECT id FROM conversations WHERE direct_key = $1', [key]);
  const id = existing.rows[0]!.id;
  // Re-add a participant who had previously left (e.g. both sides still exist but one deleted the chat).
  await client.query(
    `INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2), ($1, $3) ON CONFLICT DO NOTHING`,
    [id, a, b],
  );
  return { id, created: false };
}
