import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type pg from 'pg';
import type { Config } from '../config';
import type { AppContext, AuthInfo } from '../context';
import type { Queryable } from '../db';
import { hmac, randomToken, sha256 } from '../lib/crypto';

export type RevokeReason = 'logout' | 'replaced' | 'logout_all' | 'revoked' | 'account_deleted';

/** __Host- prefix pins the cookie to this exact origin over HTTPS (no Domain, Path=/, Secure). */
export const sessionCookieName = (cfg: Config) => (cfg.secureCookies ? '__Host-cove_session' : 'cove_session');

export function setSessionCookie(c: Context, cfg: Config, token: string) {
  setCookie(c, sessionCookieName(cfg), token, {
    httpOnly: true,
    secure: cfg.secureCookies,
    sameSite: 'Strict',
    path: '/',
    maxAge: cfg.SESSION_TTL_DAYS * 86400,
  });
}

export function clearSessionCookie(c: Context, cfg: Config) {
  deleteCookie(c, sessionCookieName(cfg), { path: '/', secure: cfg.secureCookies });
}

export const readSessionToken = (c: Context, cfg: Config) => getCookie(c, sessionCookieName(cfg));

/** CSRF token bound to the session (synchronizer-token pattern without server state). */
export const csrfTokenFor = (cfg: Config, sessionToken: string) => hmac(cfg.SESSION_SECRET, `csrf:${sessionToken}`).toString('base64url');

/**
 * Create a session inside an existing transaction. Under the single-session policy every other
 * active session of the user is revoked in the same transaction, serialised by a row lock on
 * the user so two simultaneous sign-ins cannot both survive.
 */
export async function createSession(
  client: pg.PoolClient,
  cfg: Config,
  userId: string,
  meta: { ip: string; userAgent: string | undefined },
): Promise<{ token: string; sessionId: string; replacedSessionIds: string[] }> {
  await client.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [userId]);
  let replacedSessionIds: string[] = [];
  if (cfg.SESSION_POLICY === 'single') {
    const r = await client.query<{ id: string }>(
      `UPDATE sessions SET revoked_at = now(), revoked_reason = 'replaced'
       WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
       RETURNING id`,
      [userId],
    );
    replacedSessionIds = r.rows.map((x) => x.id);
    if (replacedSessionIds.length) {
      await client.query('DELETE FROM push_subscriptions WHERE session_id = ANY($1::uuid[])', [replacedSessionIds]);
    }
    // Also close any stale rows that simply expired, so the active index stays small.
    await client.query(
      `UPDATE sessions SET revoked_at = now(), revoked_reason = 'replaced' WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
  }
  const token = randomToken(32);
  const row = await client.query<{ id: string }>(
    `INSERT INTO sessions (user_id, token_hash, expires_at, ip, user_agent)
     VALUES ($1, $2, now() + make_interval(days => $3), $4, $5) RETURNING id`,
    [userId, sha256(token), cfg.SESSION_TTL_DAYS, meta.ip || null, (meta.userAgent ?? '').slice(0, 512) || null],
  );
  return { token, sessionId: row.rows[0]!.id, replacedSessionIds };
}

/** Validate a session token: not revoked, not past absolute expiry, not idle for too long. */
export async function resolveSession(ctx: AppContext, token: string | undefined): Promise<AuthInfo | null> {
  if (!token || token.length < 32 || token.length > 64) return null;
  const row = await ctx.db.one<{ id: string; user_id: string; stale: boolean }>(
    `SELECT id, user_id, last_active_at < now() - interval '60 seconds' AS stale
     FROM sessions
     WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
       AND last_active_at > now() - make_interval(days => $2)`,
    [sha256(token), ctx.cfg.SESSION_IDLE_DAYS],
  );
  if (!row) return null;
  if (row.stale) await ctx.db.query('UPDATE sessions SET last_active_at = now() WHERE id = $1', [row.id]);
  return { userId: row.user_id, sessionId: row.id, token };
}

export async function revokeSessions(
  db: Queryable,
  where: { sessionId: string } | { userId: string; exceptSessionId?: string },
  reason: RevokeReason,
): Promise<string[]> {
  const r =
    'sessionId' in where
      ? await db.query<{ id: string }>(
          `UPDATE sessions SET revoked_at = now(), revoked_reason = $2 WHERE id = $1 AND revoked_at IS NULL RETURNING id`,
          [where.sessionId, reason],
        )
      : await db.query<{ id: string }>(
          `UPDATE sessions SET revoked_at = now(), revoked_reason = $2
           WHERE user_id = $1 AND revoked_at IS NULL AND ($3::uuid IS NULL OR id <> $3) RETURNING id`,
          [where.userId, reason, where.exceptSessionId ?? null],
        );
  const ids = r.rows.map((x) => x.id);
  if (ids.length) await db.query('DELETE FROM push_subscriptions WHERE session_id = ANY($1::uuid[])', [ids]);
  return ids;
}
