import type { AppContext } from '../context';
import type { Queryable } from '../db';
import { notFound } from '../lib/errors';

export type Audience = 'everyone' | 'contacts' | 'nobody';

export const directKey = (a: string, b: string) => (a < b ? `${a}:${b}` : `${b}:${a}`);

export function audienceAllows(aud: Audience, opts: { self: boolean; contact: boolean }) {
  if (opts.self) return true;
  if (aud === 'everyone') return true;
  if (aud === 'contacts') return opts.contact;
  return false;
}

export async function blockState(db: Queryable, a: string, b: string) {
  const r = await db.query<{ blocker_id: string }>(
    'SELECT blocker_id FROM blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)',
    [a, b],
  );
  return { aBlockedB: r.rows.some((x) => x.blocker_id === a), bBlockedA: r.rows.some((x) => x.blocker_id === b) };
}

/** "Contacts" = people you share a conversation with. There is no address book. */
export async function areContacts(db: Queryable, a: string, b: string) {
  const r = await db.query('SELECT 1 FROM conversations WHERE direct_key = $1', [directKey(a, b)]);
  return (r.rowCount ?? 0) > 0;
}

export interface ParticipantRow {
  conversation_id: string;
  user_id: string;
  peer_id: string | null;
  last_read_message_id: string;
  cleared_before_message_id: string;
  archived_at: Date | null;
  hidden_at: Date | null;
  muted: boolean;
  allow_protected_media: boolean | null;
  message_ttl_seconds: number | null;
}

/** Load the caller's participation in a conversation or 404 (never reveal other people's chats). */
export async function requireParticipant(db: Queryable, conversationId: string, userId: string, lock = false): Promise<ParticipantRow> {
  const r = await db.query<ParticipantRow>(
    `SELECT p.conversation_id, p.user_id, p.last_read_message_id, p.cleared_before_message_id, p.archived_at, p.hidden_at,
            p.muted, p.allow_protected_media, c.message_ttl_seconds,
            (SELECT o.user_id FROM conversation_participants o WHERE o.conversation_id = p.conversation_id AND o.user_id <> p.user_id LIMIT 1) AS peer_id
     FROM conversation_participants p JOIN conversations c ON c.id = p.conversation_id
     WHERE p.conversation_id = $1 AND p.user_id = $2 ${lock ? 'FOR UPDATE OF p' : ''}`,
    [conversationId, userId],
  );
  const row = r.rows[0];
  if (!row) throw notFound('Conversation not found.');
  return row;
}

/** Whether `recipientId` accepts view-once / view-twice media in this conversation. */
export async function acceptsProtectedMedia(db: Queryable, conversationId: string, recipientId: string) {
  const r = await db.query<{ allowed: boolean }>(
    `SELECT COALESCE(p.allow_protected_media, s.allow_protected_media) AS allowed
     FROM conversation_participants p JOIN user_privacy_settings s ON s.user_id = p.user_id
     WHERE p.conversation_id = $1 AND p.user_id = $2`,
    [conversationId, recipientId],
  );
  return r.rows[0]?.allowed ?? false;
}

/** Ids of everyone the user shares a conversation with. */
export async function contactIds(ctx: AppContext, userId: string): Promise<string[]> {
  const r = await ctx.db.query<{ user_id: string }>(
    `SELECT DISTINCT o.user_id FROM conversation_participants me
     JOIN conversation_participants o ON o.conversation_id = me.conversation_id AND o.user_id <> me.user_id
     WHERE me.user_id = $1`,
    [userId],
  );
  return r.rows.map((x) => x.user_id);
}
