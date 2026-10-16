/**
 * End-to-end encryption primitives for Cove (format "c1").
 *
 * Only standard, browser-implemented primitives from WebCrypto are used — no custom ciphers:
 *   identity keys   ECDH on NIST P-256
 *   pair key        HKDF-SHA-256 over the ECDH shared secret  →  AES-256-GCM key
 *   messages        AES-256-GCM, random 96-bit IV, sender/recipient bound as associated data
 *   key backup      PBKDF2-SHA-256 (high-entropy recovery key)  →  AES-256-GCM
 *
 * The same pair key protects both directions of a one-to-one chat; the associated data names the
 * direction, so a server cannot present Alice's message as Bob's (decryption would fail).
 * There is no ratchet: this scheme does not provide forward secrecy. See docs/E2EE.md.
 *
 * This module has no DOM dependencies so it also runs in Node (server tests use it).
 */

export const ENVELOPE_VERSION = 'c1';
const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });
const subtle = () => globalThis.crypto.subtle;

// ---------------------------------------------------------------------------
// encoding helpers
// ---------------------------------------------------------------------------
export function b64u(bytes: Uint8Array | ArrayBuffer): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64u(s: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('invalid base64url');
  const pad = s.length % 4 === 2 ? '==' : s.length % 4 === 3 ? '=' : '';
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const randomBytes = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(new ArrayBuffer(n)));

// ---------------------------------------------------------------------------
// identity keys
// ---------------------------------------------------------------------------
const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const;

/** Key id: first 16 bytes of SHA-256 over the raw public key (base64url, 22 chars). */
export async function kidOf(publicRaw: Uint8Array<ArrayBuffer>): Promise<string> {
  const h = new Uint8Array(await subtle().digest('SHA-256', publicRaw));
  return b64u(h.subarray(0, 16));
}

export interface GeneratedIdentity {
  kid: string;
  publicKey: string; // base64url of the 65-byte uncompressed point
  pkcs8: Uint8Array<ArrayBuffer>; // private key bytes — only ever held transiently, to build the backup
  privateKey: CryptoKey; // non-extractable copy for day-to-day use
}

export async function generateIdentity(): Promise<GeneratedIdentity> {
  const pair = await subtle().generateKey(ECDH, true, ['deriveBits']);
  const publicRaw = new Uint8Array(await subtle().exportKey('raw', pair.publicKey));
  const pkcs8 = new Uint8Array(await subtle().exportKey('pkcs8', pair.privateKey));
  const privateKey = await importPrivateKey(pkcs8);
  return { kid: await kidOf(publicRaw), publicKey: b64u(publicRaw), pkcs8, privateKey };
}

/** Import a private key as non-extractable: page scripts can use it but never read its bytes. */
export const importPrivateKey = (pkcs8: Uint8Array<ArrayBuffer>) => subtle().importKey('pkcs8', pkcs8, ECDH, false, ['deriveBits']);

export async function importPublicKey(publicKey: string): Promise<CryptoKey> {
  const raw = fromB64u(publicKey);
  if (raw.length !== 65 || raw[0] !== 4) throw new Error('invalid public key');
  return subtle().importKey('raw', raw, ECDH, true, []);
}

// ---------------------------------------------------------------------------
// pair keys and message envelopes
// ---------------------------------------------------------------------------
const HKDF_SALT = enc.encode('cove-e2ee-c1');

/** Symmetric key shared by two identity keys (same result on both sides). */
export async function derivePairKey(myPrivate: CryptoKey, myKid: string, peerPublicKey: string, peerKid: string): Promise<CryptoKey> {
  const peer = await importPublicKey(peerPublicKey);
  const shared = await subtle().deriveBits({ name: 'ECDH', public: peer }, myPrivate, 256);
  const ikm = await subtle().importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const [lo, hi] = [myKid, peerKid].sort();
  return subtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: enc.encode(`cove/c1/pair|${lo}|${hi}`) },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export interface EnvelopeMeta {
  senderId: string;
  recipientId: string;
}

export interface ParsedEnvelope {
  senderKid: string;
  recipientKid: string;
  iv: Uint8Array<ArrayBuffer>;
  ciphertext: Uint8Array<ArrayBuffer>;
}

const ENVELOPE_RE = /^c1\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{22,})$/;

export function parseEnvelope(s: string): ParsedEnvelope | null {
  const m = ENVELOPE_RE.exec(s);
  if (!m) return null;
  try {
    return { senderKid: m[1]!, recipientKid: m[2]!, iv: fromB64u(m[3]!), ciphertext: fromB64u(m[4]!) };
  } catch {
    return null;
  }
}

const aad = (meta: EnvelopeMeta, senderKid: string, recipientKid: string) =>
  enc.encode(`c1|${meta.senderId}>${meta.recipientId}|${senderKid}>${recipientKid}`);

/** Pad to a multiple of 64 bytes so ciphertext length only reveals a coarse size bucket. */
function pad(json: string): Uint8Array<ArrayBuffer> {
  const bytes = enc.encode(json);
  const target = Math.max(64, Math.ceil(bytes.length / 64) * 64);
  const out = new Uint8Array(new ArrayBuffer(target)).fill(0x20);
  out.set(bytes);
  return out;
}

export interface MessagePayload {
  t: string; // text (message body or media caption)
}

export async function seal(pairKey: CryptoKey, meta: EnvelopeMeta & { senderKid: string; recipientKid: string }, payload: MessagePayload): Promise<string> {
  const iv = randomBytes(12);
  const ct = await subtle().encrypt(
    { name: 'AES-GCM', iv, additionalData: aad(meta, meta.senderKid, meta.recipientKid) },
    pairKey,
    pad(JSON.stringify({ v: 1, ...payload })),
  );
  return `${ENVELOPE_VERSION}.${meta.senderKid}.${meta.recipientKid}.${b64u(iv)}.${b64u(ct)}`;
}

export async function open(pairKey: CryptoKey, meta: EnvelopeMeta, env: ParsedEnvelope): Promise<MessagePayload> {
  const pt = await subtle().decrypt(
    { name: 'AES-GCM', iv: env.iv, additionalData: aad(meta, env.senderKid, env.recipientKid) },
    pairKey,
    env.ciphertext,
  );
  const obj = JSON.parse(dec.decode(pt)) as { v?: number; t?: unknown };
  if (obj.v !== 1 || typeof obj.t !== 'string') throw new Error('unsupported payload');
  return { t: obj.t };
}

// ---------------------------------------------------------------------------
// recovery key and encrypted key backup
// ---------------------------------------------------------------------------
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 120 random bits as 24 Crockford base32 characters in groups of four: "7KQM-2XPA-…". */
export function generateRecoveryKey(): string {
  const bytes = randomBytes(15);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out.match(/.{4}/g)!.join('-');
}

/** Accept the key however it was typed (spaces, dashes, lower case, O/0 and I/L/1 confusion). */
export function normalizeRecoveryKey(input: string): string | null {
  const s = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/U/g, 'V');
  if (s.length !== 24 || [...s].some((c) => !CROCKFORD.includes(c))) return null;
  return s.match(/.{4}/g)!.join('-');
}

export interface KeyBackup {
  v: 1;
  kdf: 'pbkdf2-sha256';
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
}

export interface KeyringEntry {
  kid: string;
  publicKey: string;
  pkcs8: string; // base64url
  createdAt: string;
}

export const BACKUP_ITERATIONS = 210_000;

/** Derive the AES key that seals the key backup. Non-extractable; may be kept on the device. */
export async function backupKeyFrom(recoveryKey: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  const norm = normalizeRecoveryKey(recoveryKey);
  if (!norm) throw new Error('invalid recovery key');
  const base = await subtle().importKey('raw', enc.encode(norm), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function sealBackup(backupKey: CryptoKey, salt: Uint8Array<ArrayBuffer>, iterations: number, userId: string, keyring: KeyringEntry[]): Promise<KeyBackup> {
  const iv = randomBytes(12);
  const ct = await subtle().encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(`cove-backup-v1|${userId}`) },
    backupKey,
    enc.encode(JSON.stringify({ v: 1, keys: keyring })),
  );
  return { v: 1, kdf: 'pbkdf2-sha256', iterations, salt: b64u(salt), iv: b64u(iv), ciphertext: b64u(ct) };
}

export async function openBackup(backupKey: CryptoKey, userId: string, backup: KeyBackup): Promise<KeyringEntry[]> {
  const pt = await subtle().decrypt(
    { name: 'AES-GCM', iv: fromB64u(backup.iv), additionalData: enc.encode(`cove-backup-v1|${userId}`) },
    backupKey,
    fromB64u(backup.ciphertext),
  );
  const obj = JSON.parse(dec.decode(pt)) as { v: number; keys: KeyringEntry[] };
  if (obj.v !== 1 || !Array.isArray(obj.keys)) throw new Error('unsupported backup');
  return obj.keys;
}

export const newBackupSalt = () => randomBytes(16);

// ---------------------------------------------------------------------------
// safety numbers
// ---------------------------------------------------------------------------
async function fingerprintDigits(userId: string, publicKey: string): Promise<string> {
  const h = new Uint8Array(await subtle().digest('SHA-256', enc.encode(`cove-safety-v1|${userId}|${publicKey}`)));
  let out = '';
  for (let i = 0; i < 30; i += 5) {
    const n = h[i]! * 2 ** 32 + ((h[i + 1]! << 24) >>> 0) + (h[i + 2]! << 16) + (h[i + 3]! << 8) + h[i + 4]!;
    out += String(n % 100000).padStart(5, '0');
  }
  return out;
}

/**
 * A 60-digit number both people can compare (in person or on a call). It changes when either
 * person's identity key changes. Identical on both sides because the halves are ordered by user id.
 */
export async function safetyNumber(a: { userId: string; publicKey: string }, b: { userId: string; publicKey: string }): Promise<string> {
  const [first, second] = [a, b].sort((x, y) => (x.userId < y.userId ? -1 : 1));
  const digits = (await fingerprintDigits(first!.userId, first!.publicKey)) + (await fingerprintDigits(second!.userId, second!.publicKey));
  return digits.match(/.{5}/g)!.join(' ');
}
