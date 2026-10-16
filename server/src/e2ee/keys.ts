import crypto from 'node:crypto';
import { z } from 'zod';
import type { Queryable } from '../db';
import { ApiError, badRequest } from '../lib/errors';

/**
 * Server side of end-to-end encryption. The server never sees private keys or plaintext; it only:
 *  - stores public identity keys (verifying they are valid P-256 points and that the key id matches),
 *  - stores an encrypted key backup it cannot open,
 *  - checks that each envelope names the *current* keys of sender and recipient, so a client that
 *    missed a key change re-encrypts instead of sending something the other side cannot read.
 */

const KID_RE = /^[A-Za-z0-9_-]{22}$/;
const PUB_RE = /^[A-Za-z0-9_-]{87}$/;
const ENVELOPE_RE = /^c1\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{22,})$/;

/** Upper bound for a message envelope (4,096 characters of text, worst-case UTF-8, padded, base64url). */
export const MAX_ENVELOPE = 24_000;
export const MAX_NOTE_ENVELOPE = 2_400;

export function parseEnvelope(s: string): { senderKid: string; recipientKid: string } | null {
  const m = ENVELOPE_RE.exec(s);
  return m ? { senderKid: m[1]!, recipientKid: m[2]! } : null;
}

/** Validate a public key and its key id. Throws a 400 on anything malformed. */
export function verifyPublicKey(publicKey: string, kid: string) {
  if (!PUB_RE.test(publicKey) || !KID_RE.test(kid)) throw badRequest('Invalid encryption key.', 'invalid_key');
  const raw = Buffer.from(publicKey, 'base64url');
  if (raw.length !== 65 || raw[0] !== 4) throw badRequest('Invalid encryption key.', 'invalid_key');
  try {
    // Importing as JWK makes OpenSSL check that the point is on the P-256 curve.
    crypto.createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') },
      format: 'jwk',
    });
  } catch {
    throw badRequest('Invalid encryption key.', 'invalid_key');
  }
  const expected = crypto.createHash('sha256').update(raw).digest().subarray(0, 16).toString('base64url');
  if (expected !== kid) throw badRequest('Key id does not match the key.', 'invalid_key');
}

export const backupSchema = z.object({
  v: z.literal(1),
  kdf: z.literal('pbkdf2-sha256'),
  iterations: z.number().int().min(100_000).max(10_000_000),
  salt: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  iv: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
  ciphertext: z.string().regex(/^[A-Za-z0-9_-]{24,200000}$/),
});
export type KeyBackup = z.infer<typeof backupSchema>;

export async function activeKids(db: Queryable, userIds: string[]): Promise<Map<string, string>> {
  const r = await db.query<{ user_id: string; kid: string }>(
    'SELECT user_id, kid FROM user_keys WHERE user_id = ANY($1::uuid[]) AND superseded_at IS NULL',
    [userIds],
  );
  return new Map(r.rows.map((x) => [x.user_id, x.kid]));
}

/**
 * Accept `text` only if it is empty or a well-formed envelope addressed with the current keys of
 * sender and recipient. Plaintext is refused, so nothing can be stored unencrypted by mistake.
 */
export async function requireEnvelope(db: Queryable, text: string, senderId: string, recipientId: string, maxLength = MAX_ENVELOPE): Promise<string> {
  if (text === '') return '';
  if (text.length > maxLength) throw badRequest('This message is too long.', 'message_too_long');
  const env = parseEnvelope(text);
  if (!env) throw badRequest('Messages must be end-to-end encrypted. Update the app and try again.', 'not_encrypted');
  const kids = await activeKids(db, [senderId, recipientId]);
  const senderKid = kids.get(senderId);
  const recipientKid = kids.get(recipientId);
  if (!recipientKid) throw new ApiError(409, 'peer_no_key', "This person hasn't finished setting up encryption yet. Try again later.");
  if (!senderKid) throw new ApiError(409, 'no_key', 'Set up encryption on this device before sending messages.');
  if (env.senderKid !== senderKid || env.recipientKid !== recipientKid) {
    throw new ApiError(409, 'stale_key', 'Encryption keys changed. Your app will re-encrypt and retry.', { senderKid, recipientKid });
  }
  return text;
}
