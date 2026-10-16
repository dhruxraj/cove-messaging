import type { ContentfulStatusCode } from 'hono/utils/http-status';

/** An error that is safe to show to the client. Anything else becomes a generic 500. */
export class ApiError extends Error {
  constructor(
    public status: ContentfulStatusCode,
    public code: string,
    message: string,
    public extra: Record<string, unknown> = {},
    public headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export const notFound = (what = 'Not found') => new ApiError(404, 'not_found', what);
export const forbidden = (msg = 'You do not have access to this resource.') => new ApiError(403, 'forbidden', msg);
export const badRequest = (msg: string, code = 'bad_request', extra: Record<string, unknown> = {}) =>
  new ApiError(400, code, msg, extra);
export const tooMany = (msg: string, retryAfterSeconds: number, code = 'rate_limited') =>
  new ApiError(429, code, msg, { retryAfterSeconds }, { 'Retry-After': String(Math.max(1, retryAfterSeconds)) });

/** Postgres error helpers */
export function pgCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : undefined;
}
export const isUniqueViolation = (err: unknown, constraint?: string) =>
  pgCode(err) === '23505' && (!constraint || (err as { constraint?: string }).constraint === constraint);
