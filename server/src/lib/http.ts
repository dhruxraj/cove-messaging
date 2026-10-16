import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context, MiddlewareHandler } from 'hono';
import { z, ZodError, type ZodTypeAny } from 'zod';
import { csrfTokenFor, readSessionToken, resolveSession } from '../auth/sessions';
import type { AppContext, HonoEnv } from '../context';
import { timingSafeEqualStr, uuid } from './crypto';
import { ApiError } from './errors';
import { log } from './log';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    // Exactly one trusted proxy appends the real client address as the last hop.
    const xff = c.req.header('x-forwarded-for');
    const last = xff?.split(',').map((s) => s.trim()).filter(Boolean).pop();
    if (last) return last;
  }
  try {
    return getConnInfo(c).remote.address ?? '';
  } catch {
    return '';
  }
}

export function contentSecurityPolicy(ctx: AppContext) {
  const ws = ctx.cfg.wsOrigin;
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' blob: data:",
    "media-src 'self' blob:",
    `connect-src 'self' ${ws}`,
    "font-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(ctx.cfg.secureCookies ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
}

/** Baseline headers for every response; request id + client ip into context; access log. */
export function baseMiddleware(ctx: AppContext): MiddlewareHandler<HonoEnv> {
  const csp = contentSecurityPolicy(ctx);
  return async (c, next) => {
    const started = performance.now();
    c.set('requestId', uuid());
    c.set('ip', clientIp(c, ctx.cfg.TRUST_PROXY));
    await next();
    const h = c.res.headers;
    if (!h.has('Content-Security-Policy')) h.set('Content-Security-Policy', csp);
    h.set('X-Content-Type-Options', 'nosniff');
    h.set('Referrer-Policy', 'no-referrer');
    h.set('X-Frame-Options', 'DENY');
    h.set('Cross-Origin-Opener-Policy', 'same-origin');
    if (!h.has('Cross-Origin-Resource-Policy')) h.set('Cross-Origin-Resource-Policy', 'same-origin');
    h.set('Origin-Agent-Cluster', '?1');
    h.set('X-DNS-Prefetch-Control', 'off');
    h.set('X-Permitted-Cross-Domain-Policies', 'none');
    h.set('Permissions-Policy', 'camera=(), microphone=(self), geolocation=(), payment=(), usb=(), display-capture=(), interest-cohort=()');
    if (ctx.cfg.secureCookies) h.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
    if (c.req.path.startsWith('/api/') && !h.has('Cache-Control')) h.set('Cache-Control', 'no-store');
    const ms = Math.round(performance.now() - started);
    if (ctx.cfg.LOG_LEVEL === 'debug' || c.res.status >= 500 || ms > 2000) {
      // Path only: query strings are never logged.
      log.info('request', { rid: c.get('requestId'), method: c.req.method, path: c.req.path, status: c.res.status, ms });
    }
  };
}

/**
 * Reject state-changing requests that do not come from our own origin. Together with
 * SameSite=Strict cookies and the per-session CSRF token this blocks cross-site request forgery.
 */
export function originGuard(ctx: AppContext): MiddlewareHandler<HonoEnv> {
  return async (c, next) => {
    if (!SAFE_METHODS.has(c.req.method)) {
      const origin = c.req.header('origin');
      const fetchSite = c.req.header('sec-fetch-site');
      const ok = origin ? origin === ctx.cfg.APP_ORIGIN : fetchSite === 'same-origin';
      if (!ok) throw new ApiError(403, 'bad_origin', 'Request blocked: unexpected origin.');
    }
    await next();
  };
}

/** Require a valid session; for unsafe methods also require the session-bound CSRF token. */
export function requireAuth(ctx: AppContext): MiddlewareHandler<HonoEnv> {
  return async (c, next) => {
    const token = readSessionToken(c, ctx.cfg);
    const auth = await resolveSession(ctx, token);
    if (!auth) throw new ApiError(401, 'unauthenticated', 'Your session has ended. Please sign in again.');
    if (!SAFE_METHODS.has(c.req.method)) {
      const sent = c.req.header('x-csrf-token') ?? '';
      if (!sent || !timingSafeEqualStr(sent, csrfTokenFor(ctx.cfg, auth.token))) {
        throw new ApiError(403, 'csrf_failed', 'Security check failed. Refresh the page and try again.');
      }
    }
    c.set('auth', auth);
    await next();
  };
}

/** Read and validate a JSON body (bounded size, JSON content type required). */
export async function body<S extends ZodTypeAny>(c: Context, schema: S, maxBytes = 64 * 1024): Promise<z.output<S>> {
  const type = c.req.header('content-type') ?? '';
  if (!type.toLowerCase().startsWith('application/json')) {
    throw new ApiError(415, 'unsupported_media_type', 'Expected a JSON request body.');
  }
  const len = Number(c.req.header('content-length') ?? '0');
  if (len > maxBytes) throw new ApiError(413, 'payload_too_large', 'Request body is too large.');
  const reader = c.req.raw.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ApiError(413, 'payload_too_large', 'Request body is too large.');
      }
      chunks.push(value);
    }
  }
  let data: unknown;
  try {
    data = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
  } catch {
    throw new ApiError(400, 'invalid_json', 'Malformed JSON body.');
  }
  return schema.parse(data);
}

export function query<S extends ZodTypeAny>(c: Context, schema: S): z.output<S> {
  return schema.parse(c.req.query());
}

export function errorResponse(err: unknown, c: Context) {
  if (err instanceof ApiError) {
    for (const [k, v] of Object.entries(err.headers)) c.header(k, v);
    return c.json({ error: { code: err.code, message: err.message, ...err.extra } }, err.status);
  }
  if (err instanceof ZodError) {
    const issue = err.issues[0];
    const field = issue?.path.join('.');
    return c.json(
      {
        error: {
          code: 'validation_error',
          message: issue ? `${field ? field + ': ' : ''}${issue.message}` : 'Invalid request.',
          issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      },
      400,
    );
  }
  if (err && typeof err === 'object' && 'getResponse' in err && typeof (err as { getResponse: unknown }).getResponse === 'function') {
    return (err as { getResponse: () => Response }).getResponse();
  }
  log.error('unhandled error', { err, rid: c.get('requestId'), path: c.req.path });
  return c.json({ error: { code: 'internal_error', message: 'Something went wrong. Please try again.' } }, 500);
}

export const zUuid = z.string().uuid();
export const zMessageId = z.string().regex(/^\d{1,19}$/, 'invalid message id');
