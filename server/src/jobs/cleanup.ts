import type { AppContext } from '../context';
import { log } from '../lib/log';
import { purgeIfExhausted, refundAbandonedViews } from '../media/lifecycle';
import type { LocalStorage } from '../media/storage';

/**
 * Periodic maintenance. Guarded by a Postgres advisory lock so only one replica runs it at a time.
 * Every step is bounded so a large backlog is worked off over several runs.
 */
export class CleanupJob {
  private timer?: NodeJS.Timeout;
  private running = false;
  private lastHousekeeping = 0;

  constructor(private ctx: AppContext) {}

  start() {
    const every = this.ctx.cfg.CLEANUP_INTERVAL_SECONDS * 1000;
    this.timer = setInterval(() => void this.runOnce(), every);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }

  async runOnce(): Promise<Record<string, number>> {
    if (this.running) return {};
    this.running = true;
    const client = await this.ctx.db.pool.connect();
    const stats: Record<string, number> = {};
    try {
      const lock = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(727002) AS ok');
      if (!lock.rows[0]?.ok) return stats;
      try {
        stats.refunded = await refundAbandonedViews(this.ctx);
        stats.purged = await this.purgeProtectedMedia();
        stats.expiredMessages = await this.deleteExpiredMessages();
        stats.orphanUploads = await this.deleteOrphanUploads();
        stats.clearedHistory = await this.deleteHistoryClearedByEveryone();
        stats.storageDeleted = await this.drainStorageQueue();
        if (Date.now() - this.lastHousekeeping > 3600_000) {
          await this.housekeeping();
          this.lastHousekeeping = Date.now();
        }
      } finally {
        await client.query('SELECT pg_advisory_unlock(727002)');
      }
    } catch (err) {
      log.error('cleanup failed', { err });
    } finally {
      client.release();
      this.running = false;
    }
    return stats;
  }

  private async purgeProtectedMedia() {
    const r = await this.ctx.db.query<{ id: string }>(
      `SELECT a.id FROM attachments a
       WHERE a.view_policy <> 'normal' AND a.purged_at IS NULL AND a.message_id IS NOT NULL
         AND ((a.expires_at IS NOT NULL AND a.expires_at <= now())
              OR NOT EXISTS (SELECT 1 FROM media_access_grants g WHERE g.attachment_id = a.id AND g.view_limit IS NOT NULL AND g.views_used < g.view_limit))
       LIMIT 200`,
    );
    let n = 0;
    for (const row of r.rows) if (await purgeIfExhausted(this.ctx, row.id)) n++;
    return n;
  }

  private async deleteExpiredMessages() {
    const r = await this.ctx.db.query<{ id: string; conversation_id: string }>(
      `DELETE FROM messages WHERE id IN (SELECT id FROM messages WHERE expires_at <= now() ORDER BY expires_at LIMIT 1000)
       RETURNING id::text, conversation_id`,
    );
    const byConv = new Map<string, string[]>();
    for (const row of r.rows) byConv.set(row.conversation_id, [...(byConv.get(row.conversation_id) ?? []), row.id]);
    for (const [conversationId, ids] of byConv) {
      const p = await this.ctx.db.query<{ user_id: string }>('SELECT user_id FROM conversation_participants WHERE conversation_id = $1', [conversationId]);
      for (const u of p.rows) for (const id of ids) this.ctx.hub.emitToUser(u.user_id, 'message:removed', { conversationId, messageId: id });
    }
    return r.rowCount ?? 0;
  }

  /** Uploads that were never attached to a message (abandoned composer, failed send). */
  private async deleteOrphanUploads() {
    const r = await this.ctx.db.query(
      `DELETE FROM attachments WHERE id IN (
         SELECT id FROM attachments WHERE message_id IS NULL AND created_at < now() - interval '1 hour' LIMIT 500)`,
    );
    return r.rowCount ?? 0;
  }

  /** Once every participant has deleted a chat's history, the server deletes it too. */
  private async deleteHistoryClearedByEveryone() {
    const r = await this.ctx.db.query(
      `DELETE FROM messages WHERE id IN (
         SELECT m.id FROM messages m
         JOIN (SELECT conversation_id, min(cleared_before_message_id) AS cut FROM conversation_participants GROUP BY conversation_id) p
           ON p.conversation_id = m.conversation_id
         WHERE m.id <= p.cut
         LIMIT 1000)`,
    );
    return r.rowCount ?? 0;
  }

  private async drainStorageQueue() {
    const r = await this.ctx.db.query<{ key: string }>('SELECT key FROM storage_gc ORDER BY enqueued_at LIMIT 500');
    const done: string[] = [];
    for (const { key } of r.rows) {
      try {
        await this.ctx.storage.delete(key);
        done.push(key);
      } catch (err) {
        log.warn('storage delete failed', { err: (err as Error).message });
      }
    }
    if (done.length) await this.ctx.db.query('DELETE FROM storage_gc WHERE key = ANY($1::text[])', [done]);
    return done.length;
  }

  private async housekeeping() {
    const db = this.ctx.db;
    await db.query(`DELETE FROM auth_challenges WHERE created_at < now() - interval '1 day'`);
    await db.query(`DELETE FROM media_view_sessions WHERE expires_at < now() - interval '1 day'`);
    await db.query(`DELETE FROM sessions WHERE (revoked_at IS NOT NULL AND revoked_at < now() - interval '30 days') OR expires_at < now() - interval '30 days'`);
    await db.query(`DELETE FROM rate_limits WHERE window_start < now() - interval '2 days'`);
    await db.query(`DELETE FROM notifications WHERE created_at < now() - interval '90 days'`);
    await db.query(`DELETE FROM conversation_requests WHERE status IN ('rejected', 'cancelled', 'accepted') AND COALESCE(responded_at, created_at) < now() - interval '30 days'`);
    await db.query(`DELETE FROM conversations c WHERE NOT EXISTS (SELECT 1 FROM conversation_participants p WHERE p.conversation_id = c.id)`);
    const storage = this.ctx.storage as Partial<LocalStorage>;
    if (storage.sweepTemp) await storage.sweepTemp(3600_000);
  }
}
