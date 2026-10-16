import { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext, HonoEnv } from '../context';
import { generateOtp, hmac, uuid } from '../lib/crypto';
import { ApiError, notFound } from '../lib/errors';
import { body, zUuid } from '../lib/http';
import { log } from '../lib/log';
import { describeUserAgent, emails } from '../lib/mailer';
import { notify } from '../notifications/service';
import { contactIds } from '../users/access';
import { buildMe } from '../users/me';
import { consumeChallenge, createUserRows, failedAttempt, requestOtp } from './otp';
import {
  clearSessionCookie,
  createSession,
  csrfTokenFor,
  readSessionToken,
  resolveSession,
  revokeSessions,
  setSessionCookie,
} from './sessions';

export function authRoutes(ctx: AppContext) {
  const app = new Hono<HonoEnv>();
  const { cfg, db } = ctx;

  app.post('/auth/otp', async (c) => {
    const input = await body(c, z.object({ email: z.string().max(320), purpose: z.enum(['register', 'login']) }));
    const result = await requestOtp(ctx, input, c.get('ip'));
    return c.json(result);
  });

  app.post('/auth/verify', async (c) => {
    const input = await body(c, z.object({ challengeId: z.string().max(64), code: z.string().max(12) }));
    const ip = c.get('ip');
    await ctx.limiter.enforce(`otp-verify-ip:${ip}`, cfg.OTP_VERIFY_IP_MAX_PER_15MIN, 900, 'Too many attempts from this network. Try again later.');
    const userAgent = c.req.header('user-agent');

    const result = await db.tx(async (client) => {
      const res = await consumeChallenge(client, cfg.OTP_PEPPER, input.challengeId, input.code.trim(), ['register', 'login']);
      if (!res.ok) return { failed: res } as const;
      const ch = res.challenge;
      let userId = ch.user_id;
      let isNewUser = false;
      if (ch.purpose === 'register') {
        const created = await createUserRows(client, ch.email, ch.email_canonical);
        userId = created.userId;
        isNewUser = created.created;
      }
      if (!userId) throw new ApiError(400, 'invalid_challenge', 'This code is no longer valid. Request a new one.');
      const session = await createSession(client, cfg, userId, { ip, userAgent });
      return { userId, isNewUser, session, email: ch.email } as const;
    });

    if ('failed' in result && result.failed) return failedAttempt(ctx, result.failed);

    const replaced = result.session.replacedSessionIds.length > 0;
    for (const sid of result.session.replacedSessionIds) ctx.hub.disconnectSession(sid, 'replaced');
    if (replaced) {
      const info = { ip: ip || 'unknown', device: describeUserAgent(userAgent), at: new Date().toISOString() };
      await notify(ctx, result.userId, 'security_session_replaced', info);
      ctx.mailer
        .send(emails.newSignIn(cfg.APP_NAME, result.email, { when: new Date().toUTCString(), device: info.device, ip: info.ip, replaced: true }))
        .catch((err) => log.warn('security email failed', { err: (err as Error).message }));
    }

    setSessionCookie(c, cfg, result.session.token);
    return c.json({
      me: await buildMe(ctx, result.userId),
      csrfToken: csrfTokenFor(cfg, result.session.token),
      isNewUser: result.isNewUser,
      replacedPreviousSession: replaced,
    });
  });

  /** Used by the client on load to restore the signed-in state. */
  app.get('/auth/session', async (c) => {
    const token = readSessionToken(c, cfg);
    const session = await resolveSession(ctx, token);
    if (!session) {
      if (token) clearSessionCookie(c, cfg);
      throw new ApiError(401, 'unauthenticated', 'Not signed in.');
    }
    return c.json({ me: await buildMe(ctx, session.userId), csrfToken: csrfTokenFor(cfg, session.token) });
  });

  app.post('/auth/logout', async (c) => {
    const a = c.get('auth');
    await revokeSessions(db, { sessionId: a.sessionId }, 'logout');
    ctx.hub.disconnectSession(a.sessionId, 'logout');
    clearSessionCookie(c, cfg);
    // Ask the browser to drop cached media and storage from this origin.
    c.header('Clear-Site-Data', '"cache", "storage"');
    return c.json({ ok: true });
  });

  app.post('/auth/logout-all', async (c) => {
    const a = c.get('auth');
    const ids = await revokeSessions(db, { userId: a.userId }, 'logout_all');
    for (const id of ids) ctx.hub.disconnectSession(id, 'logout_all');
    clearSessionCookie(c, cfg);
    c.header('Clear-Site-Data', '"cache", "storage"');
    return c.json({ ok: true, endedSessions: ids.length });
  });

  app.get('/auth/sessions', async (c) => {
    const a = c.get('auth');
    const r = await db.query<{ id: string; created_at: Date; last_active_at: Date; ip: string | null; user_agent: string | null }>(
      `SELECT id, created_at, last_active_at, host(ip) AS ip, user_agent FROM sessions
       WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_active_at DESC`,
      [a.userId],
    );
    return c.json({
      policy: cfg.SESSION_POLICY,
      sessions: r.rows.map((s) => ({
        id: s.id,
        current: s.id === a.sessionId,
        createdAt: s.created_at.toISOString(),
        lastActiveAt: s.last_active_at.toISOString(),
        ip: s.ip,
        device: describeUserAgent(s.user_agent),
      })),
    });
  });

  app.delete('/auth/sessions/:id', async (c) => {
    const a = c.get('auth');
    const id = zUuid.parse(c.req.param('id'));
    const owned = await db.one('SELECT 1 FROM sessions WHERE id = $1 AND user_id = $2', [id, a.userId]);
    if (!owned) throw notFound('Session not found.');
    await revokeSessions(db, { sessionId: id }, 'revoked');
    ctx.hub.disconnectSession(id, 'revoked');
    if (id === a.sessionId) clearSessionCookie(c, cfg);
    return c.json({ ok: true });
  });

  // ---- Account deletion (requires a fresh email code) ----
  app.post('/account/delete/request', async (c) => {
    const a = c.get('auth');
    const user = await db.one<{ email: string; email_canonical: string }>('SELECT email, email_canonical FROM users WHERE id = $1', [a.userId]);
    if (!user) throw notFound();
    await ctx.limiter.enforce(`delete-otp:${a.userId}`, 3, 3600, 'Too many requests. Try again later.');
    const id = uuid();
    const code = generateOtp();
    await db.query(
      `INSERT INTO auth_challenges (id, purpose, email, email_canonical, user_id, code_hash, max_attempts, deliverable, expires_at, request_ip)
       VALUES ($1, 'delete_account', $2, $3, $4, $5, $6, true, now() + make_interval(secs => $7), $8)`,
      [id, user.email, user.email_canonical, a.userId, hmac(cfg.OTP_PEPPER, `${id}:${code}`), cfg.OTP_MAX_ATTEMPTS, cfg.OTP_TTL_SECONDS, c.get('ip') || null],
    );
    try {
      await ctx.mailer.send(emails.deleteCode(cfg.APP_NAME, user.email, code, Math.round(cfg.OTP_TTL_SECONDS / 60)));
    } catch {
      throw new ApiError(502, 'email_failed', "We couldn't send the email right now. Please try again.");
    }
    return c.json({ challengeId: id, codeLength: 6 });
  });

  app.post('/account/delete', async (c) => {
    const a = c.get('auth');
    const input = await body(c, z.object({ challengeId: z.string().max(64), code: z.string().max(12) }));
    const peers = await contactIds(ctx, a.userId);
    const result = await db.tx(async (client) => {
      const res = await consumeChallenge(client, cfg.OTP_PEPPER, input.challengeId, input.code.trim(), ['delete_account']);
      if (!res.ok) return { failed: res } as const;
      if (res.challenge.user_id !== a.userId) throw new ApiError(400, 'invalid_challenge', 'This code is no longer valid.');
      // Cascades remove profile, sessions, sent messages, uploads, grants, reactions, requests, blocks
      // and notifications. Storage objects are queued for deletion by triggers.
      await client.query('DELETE FROM users WHERE id = $1', [a.userId]);
      // Conversations nobody participates in any more are removed entirely.
      await client.query(
        `DELETE FROM conversations c WHERE NOT EXISTS (SELECT 1 FROM conversation_participants p WHERE p.conversation_id = c.id)`,
      );
      return { ok: true } as const;
    });
    if ('failed' in result && result.failed) return failedAttempt(ctx, result.failed);
    ctx.hub.disconnectUser(a.userId, 'account_deleted');
    for (const p of peers) ctx.hub.emitToUser(p, 'user:deleted', { userId: a.userId });
    clearSessionCookie(c, cfg);
    c.header('Clear-Site-Data', '"cache", "storage"');
    return c.json({ ok: true });
  });

  return app;
}
