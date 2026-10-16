import type pg from 'pg';
import type { AppContext } from '../context';
import { generateOtp, hmac, isUuid, timingSafeEqualBuf, uuid } from '../lib/crypto';
import { normalizeEmail } from '../lib/email-address';
import { ApiError, badRequest, tooMany } from '../lib/errors';
import { emails, type OutgoingMail } from '../lib/mailer';

export type OtpPurpose = 'register' | 'login' | 'delete_account';

export interface OtpRequestResult {
  challengeId: string;
  expiresAt: string;
  resendAfterSeconds: number;
  codeLength: 6;
}

const codeHash = (pepper: string, challengeId: string, code: string) => hmac(pepper, `${challengeId}:${code}`);

async function enforceRequestLimits(ctx: AppContext, canonical: string, ip: string) {
  const { cfg, limiter } = ctx;
  await limiter.enforce(`otp-ip:${ip}`, cfg.OTP_IP_MAX_PER_HOUR, 3600, 'Too many code requests from this network. Try again later.');
  const fails = await limiter.peek(`otp-fail:${canonical}`, 3600);
  if (fails.count >= cfg.OTP_MAX_FAILURES_PER_HOUR) {
    throw tooMany('Too many incorrect codes for this address. Try again later.', fails.resetIn, 'too_many_failures');
  }
  if (cfg.OTP_RESEND_COOLDOWN_SECONDS > 0) {
    const cd = await limiter.hit(`otp-cooldown:${canonical}`, 1, cfg.OTP_RESEND_COOLDOWN_SECONDS);
    if (!cd.allowed) throw tooMany(`Please wait ${cd.resetIn}s before requesting another code.`, cd.resetIn, 'resend_cooldown');
  }
  const hour = await limiter.hit(`otp-hour:${canonical}`, cfg.OTP_MAX_PER_HOUR, 3600);
  if (!hour.allowed) throw tooMany('Too many codes requested for this address. Try again later.', hour.resetIn);
}

async function insertAndSend(
  ctx: AppContext,
  row: { purpose: OtpPurpose; email: string; canonical: string; userId: string | null; deliverable: boolean; ip: string },
  buildMail: (code: string) => OutgoingMail,
): Promise<OtpRequestResult> {
  const { cfg, db } = ctx;
  const id = uuid();
  const code = generateOtp();
  // A code that is never sent still gets a hash of an unguessable value, so it can never verify.
  const hash = codeHash(cfg.OTP_PEPPER, id, row.deliverable ? code : `${code}:undeliverable:${uuid()}`);
  const inserted = await db.tx(async (client) => {
    // Only the newest code for an address stays valid.
    await client.query(
      `UPDATE auth_challenges SET expires_at = now()
       WHERE email_canonical = $1 AND purpose = $2 AND consumed_at IS NULL AND expires_at > now()`,
      [row.canonical, row.purpose],
    );
    const r = await client.query<{ expires_at: Date }>(
      `INSERT INTO auth_challenges (id, purpose, email, email_canonical, user_id, code_hash, max_attempts, deliverable, expires_at, request_ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(secs => $9), $10) RETURNING expires_at`,
      [id, row.purpose, row.email, row.canonical, row.userId, hash, cfg.OTP_MAX_ATTEMPTS, row.deliverable, cfg.OTP_TTL_SECONDS, row.ip || null],
    );
    return r.rows[0]!;
  });
  try {
    await ctx.mailer.send(buildMail(code));
  } catch {
    await db.query('UPDATE auth_challenges SET expires_at = now() WHERE id = $1', [id]);
    await ctx.limiter.reset(`otp-cooldown:${row.canonical}`);
    throw new ApiError(502, 'email_failed', "We couldn't send the email right now. Please try again in a moment.");
  }
  return { challengeId: id, expiresAt: inserted.expires_at.toISOString(), resendAfterSeconds: cfg.OTP_RESEND_COOLDOWN_SECONDS, codeLength: 6 };
}

/**
 * Start registration or sign-in. The response is identical whether or not an account exists, so
 * the endpoint cannot be used to discover who is registered; the email itself explains the case.
 */
export async function requestOtp(ctx: AppContext, input: { email: unknown; purpose: 'register' | 'login' }, ip: string) {
  const { cfg, db } = ctx;
  const n = normalizeEmail(input.email, cfg.ALLOWED_EMAIL_DOMAINS);
  if ('error' in n) throw badRequest(n.error, 'invalid_email');
  await enforceRequestLimits(ctx, n.canonical, ip);

  const existing = await db.one<{ id: string; email: string }>('SELECT id, email FROM users WHERE email_canonical = $1', [n.canonical]);
  const ttlMin = Math.round(cfg.OTP_TTL_SECONDS / 60);

  if (existing) {
    // Sign-in code — also used when someone "registers" an address that already has an account.
    return insertAndSend(
      ctx,
      { purpose: 'login', email: n.email, canonical: n.canonical, userId: existing.id, deliverable: true, ip },
      (code) => emails.loginCode(cfg.APP_NAME, n.email, code, ttlMin, input.purpose === 'register'),
    );
  }
  if (input.purpose === 'register') {
    return insertAndSend(
      ctx,
      { purpose: 'register', email: n.email, canonical: n.canonical, userId: null, deliverable: true, ip },
      (code) => emails.registerCode(cfg.APP_NAME, n.email, code, ttlMin),
    );
  }
  // Sign-in for an unknown address: no code is sent; the email points to registration.
  return insertAndSend(
    ctx,
    { purpose: 'login', email: n.email, canonical: n.canonical, userId: null, deliverable: false, ip },
    () => emails.noAccount(cfg.APP_NAME, n.email, cfg.APP_ORIGIN),
  );
}

type ConsumeResult =
  | { ok: true; challenge: ChallengeRow }
  | { ok: false; attemptsRemaining: number; canonical: string };

interface ChallengeRow {
  id: string;
  purpose: OtpPurpose;
  email: string;
  email_canonical: string;
  user_id: string | null;
  code_hash: Buffer;
  attempts: number;
  max_attempts: number;
  deliverable: boolean;
  expired: boolean;
  consumed_at: Date | null;
}

/**
 * Check a code against a challenge inside a transaction (row-locked, so concurrent guesses are
 * counted correctly and a code can be consumed exactly once).
 */
export async function consumeChallenge(
  client: pg.PoolClient,
  pepper: string,
  challengeId: unknown,
  code: unknown,
  purposes: OtpPurpose[],
): Promise<ConsumeResult> {
  if (!isUuid(challengeId)) throw badRequest('This code is no longer valid. Request a new one.', 'invalid_challenge');
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) throw badRequest('Enter the 6-digit code from the email.', 'invalid_code_format');
  const r = await client.query<ChallengeRow>(
    `SELECT id, purpose, email, email_canonical, user_id, code_hash, attempts, max_attempts, deliverable,
            expires_at <= now() AS expired, consumed_at
     FROM auth_challenges WHERE id = $1 AND purpose = ANY($2::otp_purpose[]) FOR UPDATE`,
    [challengeId, purposes],
  );
  const ch = r.rows[0];
  if (!ch) throw badRequest('This code is no longer valid. Request a new one.', 'invalid_challenge');
  if (ch.consumed_at) throw badRequest('This code has already been used. Request a new one.', 'code_used');
  if (ch.expired) throw badRequest('This code has expired. Request a new one.', 'code_expired');
  if (ch.attempts >= ch.max_attempts) {
    throw new ApiError(429, 'too_many_attempts', 'Too many incorrect attempts. Request a new code.', { attemptsRemaining: 0 });
  }
  await client.query('UPDATE auth_challenges SET attempts = attempts + 1 WHERE id = $1', [ch.id]);
  const matches = timingSafeEqualBuf(codeHash(pepper, ch.id, code), ch.code_hash) && ch.deliverable;
  if (!matches) return { ok: false, attemptsRemaining: ch.max_attempts - ch.attempts - 1, canonical: ch.email_canonical };
  await client.query('UPDATE auth_challenges SET consumed_at = now() WHERE id = $1', [ch.id]);
  return { ok: true, challenge: ch };
}

/** Turn a failed comparison into the client-facing error (after the attempt was committed). */
export async function failedAttempt(ctx: AppContext, res: { attemptsRemaining: number; canonical: string }): Promise<never> {
  await ctx.limiter.hit(`otp-fail:${res.canonical}`, Number.MAX_SAFE_INTEGER, 3600);
  if (res.attemptsRemaining <= 0) {
    throw new ApiError(429, 'too_many_attempts', 'Too many incorrect attempts. Request a new code.', { attemptsRemaining: 0 });
  }
  throw badRequest(
    `That code is incorrect. ${res.attemptsRemaining} ${res.attemptsRemaining === 1 ? 'attempt' : 'attempts'} left.`,
    'invalid_code',
    { attemptsRemaining: res.attemptsRemaining },
  );
}

export async function createUserRows(client: pg.PoolClient, email: string, canonical: string, defaultTtl: number | null = null) {
  const ins = await client.query<{ id: string }>(
    `INSERT INTO users (email, email_canonical) VALUES ($1, $2)
     ON CONFLICT (email_canonical) DO NOTHING RETURNING id`,
    [email, canonical],
  );
  if (!ins.rows[0]) {
    const existing = await client.query<{ id: string }>('SELECT id FROM users WHERE email_canonical = $1', [canonical]);
    return { userId: existing.rows[0]!.id, created: false };
  }
  const userId = ins.rows[0].id;
  await client.query('INSERT INTO user_profiles (user_id) VALUES ($1)', [userId]);
  await client.query('INSERT INTO user_privacy_settings (user_id, default_message_ttl_seconds) VALUES ($1, $2)', [userId, defaultTtl]);
  await client.query('INSERT INTO user_notification_settings (user_id) VALUES ($1)', [userId]);
  return { userId, created: true };
}
