import { useEffect, useState } from 'react';
import { ApiError, get, put } from '../lib/api';
import {
  b64u,
  BACKUP_ITERATIONS,
  backupKeyFrom,
  derivePairKey,
  fromB64u,
  generateIdentity,
  generateRecoveryKey,
  importPrivateKey,
  newBackupSalt,
  normalizeRecoveryKey,
  open as openEnvelope,
  openBackup,
  parseEnvelope,
  safetyNumber,
  seal,
  sealBackup,
  type GeneratedIdentity,
  type KeyBackup,
  type KeyringEntry,
} from '../lib/e2ee';
import { keystore, type KeyPin, type StoredIdentity, type StoredKey } from '../lib/keystore';
import { createStore } from '../lib/store';
import type { Me } from '../lib/types';

/**
 * Device-side end-to-end encryption: identity keys, the recovery-key backup, encrypting outgoing
 * text and decrypting incoming text. Plaintext only ever exists in this tab's memory.
 */

export type E2EEStatus = 'idle' | 'checking' | 'ready' | 'needs_setup' | 'needs_restore' | 'unsupported';

export const e2eeStore = createStore<{ status: E2EEStatus; keyId: string | null; version: number }>({ status: 'idle', keyId: null, version: 0 });
export const useE2EE = e2eeStore.useStore;

export class E2EEError extends Error {
  constructor(public code: 'no_key' | 'peer_no_key' | 'wrong_recovery_key' | 'not_ready' | 'decrypt_failed', message: string) {
    super(message);
  }
}

let userId: string | null = null;
let identity: StoredIdentity | null = null;
const peerKeys = new Map<string, { keys: Map<string, string>; active: string | null; at: number }>();
const peerFetches = new Map<string, Promise<void>>();
const pairKeys = new Map<string, Promise<CryptoKey>>();
const plainCache = new Map<string, Promise<string>>();
const plainDone = new Map<string, string>();

const bump = () => e2eeStore.set((s) => ({ version: s.version + 1 }));

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------
export async function initE2EE(me: Me): Promise<E2EEStatus> {
  userId = me.id;
  if (!keystore.supported()) {
    e2eeStore.set({ status: 'unsupported' });
    return 'unsupported';
  }
  e2eeStore.set({ status: 'checking' });
  if (!me.encryption) {
    identity = null;
    e2eeStore.set({ status: 'needs_setup', keyId: null });
    return 'needs_setup';
  }
  let stored: StoredIdentity | undefined;
  try {
    stored = await keystore.getIdentity(me.id);
  } catch {
    stored = undefined;
  }
  if (stored && stored.keys.some((k) => k.kid === me.encryption!.keyId)) {
    // Keep the active key first even if it was rotated elsewhere and restored here earlier.
    stored.keys.sort((a, b) => (a.kid === me.encryption!.keyId ? -1 : b.kid === me.encryption!.keyId ? 1 : 0));
    identity = stored;
    e2eeStore.set({ status: 'ready', keyId: me.encryption.keyId });
    bump();
    return 'ready';
  }
  identity = null;
  e2eeStore.set({ status: 'needs_restore', keyId: me.encryption.keyId });
  return 'needs_restore';
}

/** Forget everything in memory (sign-out). `wipeDevice` also deletes the stored keys. */
export async function resetE2EE(wipeDevice: boolean) {
  identity = null;
  userId = null;
  peerKeys.clear();
  pairKeys.clear();
  plainCache.clear();
  plainDone.clear();
  e2eeStore.set({ status: 'idle', keyId: null });
  if (wipeDevice) await keystore.wipe().catch(() => {});
}

export const isReady = () => !!identity && e2eeStore.get().status === 'ready';
export const activeKey = (): StoredKey | null => identity?.keys[0] ?? null;

// ---------------------------------------------------------------------------
// setup, restore, reset, rotation
// ---------------------------------------------------------------------------
export interface PreparedSetup {
  recoveryKey: string;
  identity: GeneratedIdentity;
}

/** Generate a key and recovery key locally. Nothing is uploaded until `completeSetup`. */
export async function prepareSetup(): Promise<PreparedSetup> {
  return { recoveryKey: generateRecoveryKey(), identity: await generateIdentity() };
}

async function publish(gen: GeneratedIdentity, ring: KeyringEntry[], backupKey: CryptoKey, salt: Uint8Array<ArrayBuffer>, iterations: number, replace: boolean, older: StoredKey[]): Promise<Me> {
  if (!userId) throw new E2EEError('not_ready', 'Not signed in.');
  const backup = await sealBackup(backupKey, salt, iterations, userId, ring);
  const r = await put<{ me: Me }>('/api/me/keys', { kid: gen.kid, publicKey: gen.publicKey, backup, replace });
  const now = new Date().toISOString();
  identity = {
    userId,
    keys: [{ kid: gen.kid, publicKey: gen.publicKey, privateKey: gen.privateKey, createdAt: now }, ...older],
    backupKey,
    backupSalt: b64u(salt),
    backupIterations: iterations,
  };
  await keystore.putIdentity(identity);
  // The raw private key bytes are dropped here; only the non-extractable copy remains.
  gen.pkcs8.fill(0);
  pairKeys.clear();
  e2eeStore.set({ status: 'ready', keyId: gen.kid });
  bump();
  return r.me;
}

const entry = (g: GeneratedIdentity): KeyringEntry => ({ kid: g.kid, publicKey: g.publicKey, pkcs8: b64u(g.pkcs8), createdAt: new Date().toISOString() });

/** First-time setup (or a reset that abandons old keys when `replace` is true). */
export async function completeSetup(prep: PreparedSetup, replace = false): Promise<Me> {
  const salt = newBackupSalt();
  const bk = await backupKeyFrom(prep.recoveryKey, salt, BACKUP_ITERATIONS);
  return publish(prep.identity, [entry(prep.identity)], bk, salt, BACKUP_ITERATIONS, replace, []);
}

/** Restore keys on this device from the server-held backup using the recovery key. */
export async function restoreWithRecoveryKey(input: string, expectedKeyId: string): Promise<void> {
  if (!userId) throw new E2EEError('not_ready', 'Not signed in.');
  if (!normalizeRecoveryKey(input)) throw new E2EEError('wrong_recovery_key', 'Recovery keys have 24 letters and numbers, like ABCD-EFGH-….');
  const { backup } = await get<{ backup: KeyBackup }>('/api/me/keys/backup');
  const salt = fromB64u(backup.salt);
  const bk = await backupKeyFrom(input, salt, backup.iterations);
  let ring: KeyringEntry[];
  try {
    ring = await openBackup(bk, userId, backup);
  } catch {
    throw new E2EEError('wrong_recovery_key', "That recovery key doesn't match this account. Check it and try again.");
  }
  if (!ring.some((k) => k.kid === expectedKeyId)) {
    throw new E2EEError('wrong_recovery_key', 'This backup does not contain your current key. Your key may have been reset on another device.');
  }
  const keys: StoredKey[] = [];
  for (const k of ring) {
    const bytes = fromB64u(k.pkcs8);
    keys.push({ kid: k.kid, publicKey: k.publicKey, privateKey: await importPrivateKey(bytes), createdAt: k.createdAt });
    bytes.fill(0);
  }
  keys.sort((a, b) => (a.kid === expectedKeyId ? -1 : b.kid === expectedKeyId ? 1 : b.createdAt.localeCompare(a.createdAt)));
  identity = { userId, keys, backupKey: bk, backupSalt: backup.salt, backupIterations: backup.iterations };
  await keystore.putIdentity(identity);
  pairKeys.clear();
  plainCache.clear();
  e2eeStore.set({ status: 'ready', keyId: expectedKeyId });
  bump();
}

/** Current keyring, opened with the backup key kept on this device. */
async function currentRing(): Promise<{ ring: KeyringEntry[]; salt: Uint8Array<ArrayBuffer>; iterations: number; backupKey: CryptoKey }> {
  if (!identity?.backupKey || !userId) throw new E2EEError('not_ready', 'Restore your keys with your recovery key first.');
  const { backup } = await get<{ backup: KeyBackup }>('/api/me/keys/backup');
  const ring = await openBackup(identity.backupKey, userId, backup);
  return { ring, salt: fromB64u(backup.salt), iterations: backup.iterations, backupKey: identity.backupKey };
}

/** New identity key; older keys stay in the backup so history remains readable. */
export async function rotateKey(): Promise<Me> {
  const { ring, salt, iterations, backupKey } = await currentRing();
  const gen = await generateIdentity();
  return publish(gen, [entry(gen), ...ring], backupKey, salt, iterations, true, identity!.keys);
}

/** Start over without the recovery key: a new key, and earlier messages become unreadable. */
export async function resetKeys(prep: PreparedSetup): Promise<Me> {
  return completeSetup(prep, true);
}

/** Issue a new recovery key (re-seals the backup). The old recovery key stops working. */
export async function replaceRecoveryKey(): Promise<{ recoveryKey: string; me: Me }> {
  const { ring } = await currentRing();
  const recoveryKey = generateRecoveryKey();
  const salt = newBackupSalt();
  const bk = await backupKeyFrom(recoveryKey, salt, BACKUP_ITERATIONS);
  const backup = await sealBackup(bk, salt, BACKUP_ITERATIONS, userId!, ring);
  const r = await put<{ me: Me }>('/api/me/keys/backup', { backup });
  identity = { ...identity!, backupKey: bk, backupSalt: b64u(salt), backupIterations: BACKUP_ITERATIONS };
  await keystore.putIdentity(identity);
  return { recoveryKey, me: r.me };
}

// ---------------------------------------------------------------------------
// contacts' keys
// ---------------------------------------------------------------------------
async function fetchPeerKeys(peerId: string) {
  let p = peerFetches.get(peerId);
  if (!p) {
    p = (async () => {
      const r = await get<{ keys: { kid: string; publicKey: string; active: boolean }[] }>(`/api/users/${peerId}/keys`);
      peerKeys.set(peerId, { keys: new Map(r.keys.map((k) => [k.kid, k.publicKey])), active: r.keys.find((k) => k.active)?.kid ?? null, at: Date.now() });
    })().finally(() => peerFetches.delete(peerId));
    peerFetches.set(peerId, p);
  }
  return p;
}

/** Called when the server reports that a contact's key changed. */
export function invalidatePeer(peerId: string) {
  peerKeys.delete(peerId);
  bump();
}

async function peerActive(peerId: string, expectedKid?: string | null): Promise<{ kid: string; publicKey: string } | null> {
  let rec = peerKeys.get(peerId);
  if (!rec || (expectedKid && rec.active !== expectedKid) || Date.now() - rec.at > 10 * 60_000) {
    await fetchPeerKeys(peerId);
    rec = peerKeys.get(peerId);
  }
  if (!rec?.active) return null;
  return { kid: rec.active, publicKey: rec.keys.get(rec.active)! };
}

async function peerPublic(peerId: string, kid: string): Promise<string | null> {
  let rec = peerKeys.get(peerId);
  if (!rec?.keys.has(kid)) {
    await fetchPeerKeys(peerId);
    rec = peerKeys.get(peerId);
  }
  return rec?.keys.get(kid) ?? null;
}

function pairKey(mine: StoredKey, peerKid: string, peerPub: string) {
  const id = `${mine.kid}|${peerKid}`;
  let p = pairKeys.get(id);
  if (!p) {
    p = derivePairKey(mine.privateKey, mine.kid, peerPub, peerKid);
    p.catch(() => pairKeys.delete(id));
    pairKeys.set(id, p);
  }
  return p;
}

// ---------------------------------------------------------------------------
// encrypt / decrypt
// ---------------------------------------------------------------------------
/** Encrypt text for `peerId`. `expectedPeerKid` (from the conversation) forces a key refresh if stale. */
export async function encryptFor(peerId: string, text: string, expectedPeerKid?: string | null): Promise<string> {
  const mine = activeKey();
  if (!mine || !userId) throw new E2EEError('not_ready', 'Encryption is not set up on this device.');
  const peer = await peerActive(peerId, expectedPeerKid);
  if (!peer) throw new E2EEError('peer_no_key', "This person hasn't finished setting up encryption yet.");
  void observePeerKey(peerId, peer.kid);
  const pk = await pairKey(mine, peer.kid, peer.publicKey);
  const env = await seal(pk, { senderId: userId, recipientId: peerId, senderKid: mine.kid, recipientKid: peer.kid }, { t: text });
  plainDone.set(env, text);
  plainCache.set(env, Promise.resolve(text));
  return env;
}

/** Re-fetch a contact's keys after the server said ours were stale (key changed meanwhile). */
export async function refreshPeer(peerId: string) {
  peerKeys.delete(peerId);
  await fetchPeerKeys(peerId).catch(() => {});
}

/** Decrypt an envelope between me and a contact. Memoised by envelope (each has a unique IV). */
export function decrypt(envelope: string, senderId: string, recipientId: string): Promise<string> {
  let p = plainCache.get(envelope);
  if (p) return p;
  p = (async () => {
    if (!identity || !userId) throw new E2EEError('not_ready', 'Encryption is not set up on this device.');
    const env = parseEnvelope(envelope);
    if (!env) throw new E2EEError('decrypt_failed', 'Unreadable message.');
    const iAmSender = senderId === userId;
    if (!iAmSender && recipientId !== userId) throw new E2EEError('decrypt_failed', 'Not addressed to you.');
    const myKid = iAmSender ? env.senderKid : env.recipientKid;
    const peerKid = iAmSender ? env.recipientKid : env.senderKid;
    const peerId = iAmSender ? recipientId : senderId;
    const mine = identity.keys.find((k) => k.kid === myKid);
    if (!mine) throw new E2EEError('no_key', 'This message was encrypted for a key this device does not have.');
    const pub = await peerPublic(peerId, peerKid);
    if (!pub) throw new E2EEError('decrypt_failed', 'Missing contact key.');
    const pk = await pairKey(mine, peerKid, pub);
    try {
      return (await openEnvelope(pk, { senderId, recipientId }, env)).t;
    } catch {
      throw new E2EEError('decrypt_failed', 'This message could not be decrypted.');
    }
  })();
  plainCache.set(envelope, p);
  p.then(
    (t) => plainDone.set(envelope, t),
    // Allow a retry after keys change (e.g. restored on this device).
    () => plainCache.delete(envelope),
  );
  return p;
}

export const peekPlain = (envelope: string) => plainDone.get(envelope);

export type PlainState = { status: 'empty' } | { status: 'pending' } | { status: 'ok'; text: string } | { status: 'error'; reason: string };

/** React hook: the plaintext of an envelope, decrypted lazily and cached. */
export function usePlaintext(envelope: string | null | undefined, senderId: string | null | undefined, recipientId: string | null | undefined): PlainState {
  const version = useE2EE((s) => s.version);
  const initial = (): PlainState => {
    if (!envelope) return { status: 'empty' };
    const done = plainDone.get(envelope);
    return done ? { status: 'ok', text: done } : { status: 'pending' };
  };
  const [state, setState] = useState<PlainState>(initial);
  useEffect(() => {
    if (!envelope || !senderId || !recipientId) {
      setState(envelope ? { status: 'error', reason: 'Message unavailable' } : { status: 'empty' });
      return;
    }
    const done = plainDone.get(envelope);
    if (done) {
      setState({ status: 'ok', text: done });
      return;
    }
    let alive = true;
    setState((s) => (s.status === 'ok' ? s : { status: 'pending' }));
    decrypt(envelope, senderId, recipientId).then(
      (text) => alive && setState({ status: 'ok', text }),
      (err: unknown) => alive && setState({ status: 'error', reason: err instanceof E2EEError && err.code === 'no_key' ? 'Encrypted for a previous key' : 'Unable to decrypt' }),
    );
    return () => {
      alive = false;
    };
  }, [envelope, senderId, recipientId, version]);
  return state;
}

// ---------------------------------------------------------------------------
// verification (safety numbers) and key pinning
// ---------------------------------------------------------------------------
const pinId = (peerId: string) => `${userId}:${peerId}`;

/**
 * Trust on first use: remember each contact's key. If a key the user had verified changes, flag it
 * so the chat shows a warning — this does not rely on the server announcing the change.
 */
export async function observePeerKey(peerId: string, kid: string): Promise<KeyPin | null> {
  if (!userId) return null;
  try {
    const pin = await keystore.getPin(pinId(peerId));
    if (!pin) {
      const fresh: KeyPin = { id: pinId(peerId), kid, verified: false, verifiedAt: null, changedAfterVerify: false };
      await keystore.putPin(fresh);
      return fresh;
    }
    if (pin.kid !== kid) {
      const next: KeyPin = { ...pin, kid, verified: false, verifiedAt: null, changedAfterVerify: pin.verified || pin.changedAfterVerify };
      await keystore.putPin(next);
      bump();
      return next;
    }
    return pin;
  } catch {
    return null;
  }
}

export async function getPin(peerId: string): Promise<KeyPin | null> {
  if (!userId) return null;
  return (await keystore.getPin(pinId(peerId)).catch(() => undefined)) ?? null;
}

export async function setVerified(peerId: string, kid: string, verified: boolean) {
  await keystore.putPin({ id: pinId(peerId), kid, verified, verifiedAt: verified ? new Date().toISOString() : null, changedAfterVerify: false });
  bump();
}

export async function dismissKeyWarning(peerId: string) {
  const pin = await getPin(peerId);
  if (pin) await keystore.putPin({ ...pin, changedAfterVerify: false });
  bump();
}

/** Safety number for me and a contact (current keys), or null if either key is missing. */
export async function safetyNumberWith(peerId: string): Promise<{ number: string; peerKid: string } | null> {
  const mine = activeKey();
  if (!mine || !userId) return null;
  const peer = await peerActive(peerId).catch(() => null);
  if (!peer) return null;
  return { number: await safetyNumber({ userId, publicKey: mine.publicKey }, { userId: peerId, publicKey: peer.publicKey }), peerKid: peer.kid };
}

/** Short human-readable fingerprint of my key for the security settings screen. */
export function myFingerprint(): string | null {
  const k = activeKey();
  if (!k) return null;
  return k.kid.slice(0, 20).replace(/(.{4})/g, '$1 ').trim();
}

export const isE2EEError = (e: unknown): e is E2EEError => e instanceof E2EEError;
export const isStaleKeyError = (e: unknown) => e instanceof ApiError && e.code === 'stale_key';
