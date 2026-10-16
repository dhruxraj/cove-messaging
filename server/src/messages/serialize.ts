export interface MessageRow {
  id: string;
  conversation_id: string;
  sender_id: string | null;
  client_id: string | null;
  kind: string;
  body: string;
  reply_to_id: string | null;
  forwarded: boolean;
  system_event: Record<string, unknown> | null;
  created_at: Date;
  edited_at: Date | null;
  deleted_at: Date | null;
  delivered_at: Date | null;
  read_at: Date | null;
  expires_at: Date | null;
  a_id: string | null;
  a_kind: string | null;
  a_mime: string | null;
  a_file_name: string | null;
  a_size: string | null;
  a_width: number | null;
  a_height: number | null;
  a_duration_ms: number | null;
  a_has_thumb: boolean | null;
  a_view_policy: 'normal' | 'once' | 'twice' | null;
  a_expired: boolean | null;
  a_purged_at: Date | null;
  g_view_limit: number | null;
  g_views_used: number | null;
  g_exists: boolean | null;
  rg_view_limit: number | null;
  rg_views_used: number | null;
  r_id: string | null;
  r_sender_id: string | null;
  r_kind: string | null;
  r_body: string | null;
  r_deleted_at: Date | null;
  r_unavailable: boolean | null;
  r_view_policy: string | null;
  reactions: { emoji: string; userId: string }[];
}

/**
 * Shared SELECT for messages as seen by viewer $1. Joins the attachment, the viewer's media grant,
 * the recipient's grant (so senders see "opened"), the reply target and the reactions.
 */
export const MESSAGE_SELECT = `
  SELECT m.id::text, m.conversation_id, m.sender_id, m.client_id, m.kind, m.body, m.reply_to_id::text, m.forwarded, m.system_event,
         m.created_at, m.edited_at, m.deleted_at, m.delivered_at, m.read_at, m.expires_at,
         a.id AS a_id, a.kind AS a_kind, a.mime AS a_mime, a.file_name AS a_file_name, a.size_bytes::text AS a_size,
         a.width AS a_width, a.height AS a_height, a.duration_ms AS a_duration_ms, (a.thumb_key IS NOT NULL) AS a_has_thumb,
         a.view_policy AS a_view_policy, (a.expires_at IS NOT NULL AND a.expires_at <= now()) AS a_expired, a.purged_at AS a_purged_at,
         g.view_limit AS g_view_limit, g.views_used AS g_views_used, (g.attachment_id IS NOT NULL) AS g_exists,
         rg.view_limit AS rg_view_limit, rg.views_used AS rg_views_used,
         r.id::text AS r_id, r.sender_id AS r_sender_id, r.kind AS r_kind, r.body AS r_body, r.deleted_at AS r_deleted_at,
         (r.id IS NOT NULL AND (r.id <= vp.cleared_before_message_id OR (r.expires_at IS NOT NULL AND r.expires_at <= now())
            OR EXISTS (SELECT 1 FROM message_hidden rh WHERE rh.user_id = $1 AND rh.message_id = r.id))) AS r_unavailable,
         ra.view_policy AS r_view_policy,
         COALESCE((SELECT json_agg(json_build_object('emoji', x.emoji, 'userId', x.user_id) ORDER BY x.created_at)
                   FROM message_reactions x WHERE x.message_id = m.id), '[]'::json) AS reactions
  FROM messages m
  JOIN conversation_participants vp ON vp.conversation_id = m.conversation_id AND vp.user_id = $1
  LEFT JOIN attachments a ON a.message_id = m.id
  LEFT JOIN media_access_grants g ON g.attachment_id = a.id AND g.user_id = $1
  LEFT JOIN LATERAL (
    SELECT g2.view_limit, g2.views_used FROM media_access_grants g2
    WHERE g2.attachment_id = a.id AND g2.user_id <> m.sender_id LIMIT 1
  ) rg ON m.sender_id = $1 AND a.view_policy <> 'normal'
  LEFT JOIN messages r ON r.id = m.reply_to_id
  LEFT JOIN attachments ra ON ra.message_id = r.id`;

/** Messages the viewer may see: after their "clear chat" point, not hidden for them, not expired. */
export const VISIBLE_TO_VIEWER = `
  m.id > vp.cleared_before_message_id
  AND (m.expires_at IS NULL OR m.expires_at > now())
  AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.user_id = $1 AND h.message_id = m.id)`;

export type ProtectedState = 'unopened' | 'partially_viewed' | 'opened' | 'expired';

function protectedState(limit: number | null, used: number | null, expired: boolean, purged: boolean): ProtectedState {
  if (limit !== null && used !== null && used >= limit) return 'opened';
  if (expired || purged) return 'expired';
  if (used && used > 0) return 'partially_viewed';
  return 'unopened';
}

export function kindLabel(kind: string | null, viewPolicy?: string | null): string {
  const once = viewPolicy === 'once' ? 'View once ' : viewPolicy === 'twice' ? 'View twice ' : '';
  switch (kind) {
    case 'image':
      return once ? `${once}photo` : 'Photo';
    case 'video':
      return once ? `${once}video` : 'Video';
    case 'voice':
      return once ? `${once}voice message` : 'Voice message';
    case 'audio':
      return once ? `${once}audio` : 'Audio';
    case 'file':
      return 'Document';
    default:
      return 'Message';
  }
}

/**
 * A content-free label for a message ("Photo", "View once video", "Message"). Message text is
 * end-to-end encrypted, so the server cannot build text previews; clients decrypt `body` and
 * build their own. This label is only a fallback (and what push notifications show).
 */
export function previewText(kind: string, viewPolicy: string | null, deleted: boolean): string {
  if (deleted) return 'This message was deleted';
  if (kind === 'text') return 'Message';
  if (viewPolicy && viewPolicy !== 'normal') return kindLabel(kind, viewPolicy);
  return kindLabel(kind);
}

export function serializeMessage(row: MessageRow, viewerId: string, receiptsVisible: boolean) {
  const mine = row.sender_id === viewerId;
  const deleted = !!row.deleted_at;
  let attachment: Record<string, unknown> | null = null;
  if (row.a_id && !deleted) {
    const purged = !!row.a_purged_at;
    if (row.a_view_policy === 'normal') {
      attachment = {
        id: row.a_id,
        kind: row.a_kind,
        mime: row.a_mime,
        fileName: row.a_file_name,
        size: Number(row.a_size),
        width: row.a_width,
        height: row.a_height,
        durationMs: row.a_duration_ms,
        viewPolicy: 'normal',
        hasThumbnail: !!row.a_has_thumb,
        available: !purged && !!row.g_exists,
      };
    } else {
      const limit = mine ? row.rg_view_limit : row.g_view_limit;
      const used = mine ? row.rg_views_used : row.g_views_used;
      const state = protectedState(limit, used, !!row.a_expired, purged);
      attachment = {
        id: row.a_id,
        kind: row.a_kind,
        mime: row.a_mime,
        size: Number(row.a_size),
        durationMs: row.a_duration_ms,
        viewPolicy: row.a_view_policy,
        viewLimit: limit,
        viewsUsed: used ?? 0,
        viewsRemaining: limit !== null && used !== null ? Math.max(0, limit - used) : 0,
        state,
        // Senders never get access to view-once media after sending.
        canView: !mine && !!row.g_exists && (state === 'unopened' || state === 'partially_viewed'),
      };
    }
  }
  let status: 'sent' | 'delivered' | 'read' | undefined;
  if (mine && row.kind !== 'system') status = row.read_at && receiptsVisible ? 'read' : row.delivered_at ? 'delivered' : 'sent';
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    clientId: mine ? row.client_id : null,
    kind: row.kind,
    body: deleted ? '' : row.body,
    createdAt: row.created_at.toISOString(),
    editedAt: row.edited_at && !deleted ? row.edited_at.toISOString() : null,
    deleted,
    forwarded: row.forwarded,
    expiresAt: row.expires_at?.toISOString() ?? null,
    system: row.system_event,
    replyTo: row.r_id
      ? {
          id: row.r_id,
          senderId: row.r_sender_id,
          kind: row.r_kind,
          preview: row.r_unavailable ? 'Message unavailable' : previewText(row.r_kind ?? 'text', row.r_view_policy, !!row.r_deleted_at),
          // Encrypted text of the quoted message, so the client can show what is being replied to.
          body: row.r_unavailable || row.r_deleted_at ? '' : (row.r_body ?? ''),
          viewPolicy: row.r_view_policy,
          deleted: !!row.r_deleted_at,
          unavailable: !!row.r_unavailable,
        }
      : null,
    reactions: deleted ? [] : row.reactions,
    status,
    attachment,
  };
}

export type SerializedMessage = ReturnType<typeof serializeMessage>;
