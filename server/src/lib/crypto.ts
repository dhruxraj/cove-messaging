import crypto from 'node:crypto';

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

export const sha256 = (input: string | Buffer) => crypto.createHash('sha256').update(input).digest();

export const hmac = (key: string, input: string) => crypto.createHmac('sha256', key).update(input).digest();

export function timingSafeEqualBuf(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  // Hash first so lengths always match and timing does not leak the prefix length.
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

/** Uniformly random 6-digit code (000000–999999) from the CSPRNG. */
export const generateOtp = () => crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');

export const uuid = () => crypto.randomUUID();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID_RE.test(s);
