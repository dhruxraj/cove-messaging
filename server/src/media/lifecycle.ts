import type { AppContext } from '../context';
import { broadcastMessage } from '../messages/service';

/**
 * Remove the original bytes of a view-once/view-twice attachment once nobody can view it any more:
 * every grant has used its allowance (or the media expired) and no viewing session is in flight.
 * The attachment row stays so both sides keep seeing "Opened" / "Expired".
 */
export async function purgeIfExhausted(ctx: AppContext, attachmentId: string): Promise<boolean> {
  const r = await ctx.db.tx(async (client) => {
    const res = await client.query<{ storage_key: string; message_id: string; conversation_id: string }>(
      `UPDATE attachments a SET purged_at = now()
       WHERE a.id = $1 AND a.view_policy <> 'normal' AND a.purged_at IS NULL
         AND (
           (a.expires_at IS NOT NULL AND a.expires_at <= now())
           OR NOT EXISTS (SELECT 1 FROM media_access_grants g WHERE g.attachment_id = a.id AND g.view_limit IS NOT NULL AND g.views_used < g.view_limit)
         )
         AND NOT EXISTS (
           SELECT 1 FROM media_view_sessions s
           WHERE s.attachment_id = a.id AND s.completed_at IS NULL AND s.refunded_at IS NULL AND s.expires_at > now()
         )
       RETURNING a.storage_key, a.message_id::text, a.conversation_id`,
      [attachmentId],
    );
    const row = res.rows[0];
    if (!row) return null;
    await client.query('INSERT INTO storage_gc (key) VALUES ($1) ON CONFLICT DO NOTHING', [row.storage_key]);
    await client.query('UPDATE media_view_sessions SET expires_at = LEAST(expires_at, now()) WHERE attachment_id = $1', [attachmentId]);
    return row;
  });
  if (r?.message_id) await broadcastMessage(ctx, r.conversation_id, r.message_id, 'message:updated');
  return !!r;
}

/**
 * A viewing session that expired before any byte of content was requested (the open failed,
 * the network dropped, the tab closed) gives the view back. Once content delivery has started
 * the view counts, even if the transfer is later interrupted — see docs/SECURITY.md.
 */
export async function refundAbandonedViews(ctx: AppContext): Promise<number> {
  const refunded = await ctx.db.tx(async (client) => {
    const s = await client.query<{ attachment_id: string; user_id: string }>(
      `UPDATE media_view_sessions SET refunded_at = now()
       WHERE expires_at <= now() AND content_started_at IS NULL AND completed_at IS NULL AND refunded_at IS NULL
       RETURNING attachment_id, user_id`,
    );
    for (const row of s.rows) {
      await client.query(
        `UPDATE media_access_grants SET views_used = views_used - 1
         WHERE attachment_id = $1 AND user_id = $2 AND views_used > 0`,
        [row.attachment_id, row.user_id],
      );
    }
    return s.rows;
  });
  for (const row of refunded) {
    const m = await ctx.db.one<{ id: string; conversation_id: string }>('SELECT message_id::text AS id, conversation_id FROM attachments WHERE id = $1', [row.attachment_id]);
    if (m?.id) await broadcastMessage(ctx, m.conversation_id, m.id, 'message:updated');
  }
  return refunded.length;
}
