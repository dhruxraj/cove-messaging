import type { Database } from '../db';
import { tooMany } from './errors';

/**
 * Fixed-window counters stored in Postgres so limits hold across restarts and replicas.
 * `hit` increments and reports; `enforce` throws a 429 ApiError when over the limit.
 */
export class RateLimiter {
  constructor(private db: Database) {}

  async hit(key: string, limit: number, windowSeconds: number): Promise<{ allowed: boolean; count: number; resetIn: number }> {
    const row = await this.db.one<{ count: number; reset_in: number }>(
      `INSERT INTO rate_limits (key, window_start, count) VALUES ($1, now(), 1)
       ON CONFLICT (key) DO UPDATE SET
         count = CASE WHEN rate_limits.window_start <= now() - make_interval(secs => $2) THEN 1 ELSE rate_limits.count + 1 END,
         window_start = CASE WHEN rate_limits.window_start <= now() - make_interval(secs => $2) THEN now() ELSE rate_limits.window_start END
       RETURNING count, GREATEST(1, ceil(extract(epoch FROM (window_start + make_interval(secs => $2) - now()))))::int AS reset_in`,
      [key, windowSeconds],
    );
    const count = row?.count ?? 1;
    return { allowed: count <= limit, count, resetIn: row?.reset_in ?? windowSeconds };
  }

  /** Current count without incrementing. */
  async peek(key: string, windowSeconds: number): Promise<{ count: number; resetIn: number }> {
    const row = await this.db.one<{ count: number; reset_in: number }>(
      `SELECT count, GREATEST(1, ceil(extract(epoch FROM (window_start + make_interval(secs => $2) - now()))))::int AS reset_in
       FROM rate_limits WHERE key = $1 AND window_start > now() - make_interval(secs => $2)`,
      [key, windowSeconds],
    );
    return { count: row?.count ?? 0, resetIn: row?.reset_in ?? 0 };
  }

  async enforce(key: string, limit: number, windowSeconds: number, message = 'Too many requests. Please slow down.') {
    const r = await this.hit(key, limit, windowSeconds);
    if (!r.allowed) throw tooMany(message, r.resetIn);
    return r;
  }

  async reset(key: string) {
    await this.db.query('DELETE FROM rate_limits WHERE key = $1', [key]);
  }
}
