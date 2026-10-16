import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import WebSocket from 'ws';
import { createApp, type AppInstance } from '../../src/app';
import { loadConfig, type Config } from '../../src/config';
import { configureLogger } from '../../src/lib/log';
import * as e2ee from '../../../web/src/lib/e2ee';
import { SmtpSink } from './smtp-sink';

export const ORIGIN = 'http://localhost:5999';
export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:devpassword@127.0.0.1:5432/cove_test';

export async function resetDatabase(url = TEST_DB) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await client.end();
}

export interface Harness {
  /** Origin the server accepts (defaults to ORIGIN). */
  origin?: string;
  inst: AppInstance;
  cfg: Config;
  sink: SmtpSink;
  base: string;
  storageDir: string;
  db: AppInstance['ctx']['db'];
  close(): Promise<void>;
}

export async function startHarness(env: Record<string, string> = {}, opts: { reset?: boolean; sink?: SmtpSink; storageDir?: string } = {}): Promise<Harness> {
  configureLogger({ level: 'error', silent: !process.env.TEST_LOGS });
  const sink = opts.sink ?? (await new SmtpSink().start());
  const storageDir = opts.storageDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'cove-test-'));
  if (opts.reset !== false) await resetDatabase();
  const cfg = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DB,
    APP_ORIGIN: ORIGIN,
    TRUST_PROXY: 'true',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(sink.port),
    STORAGE_DIR: storageDir,
    WEB_DIST_DIR: '',
    OTP_RESEND_COOLDOWN_SECONDS: '0',
    OTP_MAX_PER_HOUR: '100',
    OTP_MAX_FAILURES_PER_HOUR: '1000',
    MAX_IMAGE_MB: '4',
    MAX_FILE_MB: '3',
    MAX_VIDEO_MB: '20',
    MAX_AUDIO_MB: '8',
    MAX_PROTECTED_MB: '8',
    CLEANUP_INTERVAL_SECONDS: '3600',
    LOG_LEVEL: 'error',
    ...env,
  });
  const inst = await createApp(cfg);
  const { port } = await inst.listen(0, '127.0.0.1');
  return {
    inst,
    cfg,
    sink,
    base: `http://127.0.0.1:${port}`,
    storageDir,
    db: inst.ctx.db,
    async close() {
      await inst.close();
      if (!opts.sink) await sink.stop();
      if (!opts.storageDir) fs.rmSync(storageDir, { recursive: true, force: true });
    },
  };
}

export interface Res<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

let ipCounter = 1;

/** A browser-like client: cookie jar, Origin header, CSRF token, distinct client IP. */
export class Client {
  cookies = new Map<string, string>();
  csrf = '';
  ip = `10.0.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;
  me: any = null;
  sockets: TestSocket[] = [];
  /** Current end-to-end identity (generated exactly like the web client does) and older ones. */
  identity: e2ee.GeneratedIdentity | null = null;
  oldIdentities: e2ee.GeneratedIdentity[] = [];
  recoveryKey = '';
  private peers = new Map<string, string>();

  constructor(public h: Harness) {}

  /** Create (or with replace=true rotate) the identity key and upload it with a sealed backup. */
  async setupKeys(replace = false) {
    const id = await e2ee.generateIdentity();
    const recoveryKey = e2ee.generateRecoveryKey();
    const salt = e2ee.newBackupSalt();
    const bk = await e2ee.backupKeyFrom(recoveryKey, salt, 100_000);
    const ring = [...(this.identity ? [this.identity] : []), ...this.oldIdentities, id].map((k) => ({ kid: k.kid, publicKey: k.publicKey, pkcs8: e2ee.b64u(k.pkcs8), createdAt: new Date().toISOString() }));
    const backup = await e2ee.sealBackup(bk, salt, 100_000, this.id, ring);
    const r = await this.req('PUT', '/api/me/keys', { json: { kid: id.kid, publicKey: id.publicKey, backup, replace } });
    if (r.status !== 200) throw new Error(`key setup failed ${r.status} ${JSON.stringify(r.body)}`);
    if (this.identity) this.oldIdentities.unshift(this.identity);
    this.identity = id;
    this.recoveryKey = recoveryKey;
    this.me = r.body.me;
    return r;
  }

  async keysOf(userId: string): Promise<{ kid: string; publicKey: string; active: boolean }[]> {
    const r = await this.get(`/api/users/${userId}/keys`);
    if (r.status !== 200) throw new Error(`keys fetch failed ${r.status}`);
    return r.body.keys;
  }

  /** Encrypt text to `peerId`'s current key, exactly as the web client does. */
  async seal(peerId: string, text: string): Promise<string> {
    const active = (await this.keysOf(peerId)).find((k) => k.active);
    if (!active || !this.identity) throw new Error('missing keys');
    const pk = await e2ee.derivePairKey(this.identity.privateKey, this.identity.kid, active.publicKey, active.kid);
    return e2ee.seal(pk, { senderId: this.id, recipientId: peerId, senderKid: this.identity.kid, recipientKid: active.kid }, { t: text });
  }

  /** Decrypt an envelope sent from senderId to recipientId (this client must be one of them). */
  async open(envelope: string, senderId: string, recipientId: string): Promise<string> {
    const env = e2ee.parseEnvelope(envelope);
    if (!env) throw new Error(`not an envelope: ${envelope.slice(0, 20)}`);
    const iAmSender = senderId === this.id;
    const myKid = iAmSender ? env.senderKid : env.recipientKid;
    const peerKid = iAmSender ? env.recipientKid : env.senderKid;
    const mine = [this.identity, ...this.oldIdentities].find((k) => k?.kid === myKid);
    const peerKey = (await this.keysOf(iAmSender ? recipientId : senderId)).find((k) => k.kid === peerKid);
    if (!mine || !peerKey) throw new Error('no key for envelope');
    const pk = await e2ee.derivePairKey(mine.privateKey, mine.kid, peerKey.publicKey, peerKey.kid);
    return (await e2ee.open(pk, { senderId, recipientId }, env)).t;
  }

  async peerIn(conversationId: string): Promise<string> {
    let p = this.peers.get(conversationId);
    if (!p) {
      const r = await this.get(`/api/conversations/${conversationId}`);
      p = r.body.conversation?.peer?.id as string;
      if (!p) throw new Error('no peer');
      this.peers.set(conversationId, p);
    }
    return p;
  }

  /** Send an end-to-end encrypted text message. */
  async sendText(conversationId: string, text: string, extra: Record<string, unknown> = {}) {
    const peer = await this.peerIn(conversationId);
    return this.post(`/api/conversations/${conversationId}/messages`, { clientId: randomUUID(), body: await this.seal(peer, text), ...extra });
  }

  /** Plaintext of a serialized message as this client sees it ('' when it has no text). */
  async textOf(m: { conversationId: string; senderId: string; body: string }): Promise<string> {
    if (!m.body) return '';
    const peer = await this.peerIn(m.conversationId);
    return this.open(m.body, m.senderId, m.senderId === this.id ? peer : this.id);
  }

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async req<T = any>(method: string, p: string, opts: { json?: unknown; body?: RequestInit['body'] | Buffer; headers?: Record<string, string>; origin?: string | null; csrf?: boolean } = {}): Promise<Res<T>> {
    const headers: Record<string, string> = { 'x-forwarded-for': this.ip, ...opts.headers };
    if (opts.origin !== null) headers.origin = opts.origin ?? this.h.origin ?? ORIGIN;
    if (this.cookies.size) headers.cookie = this.cookieHeader();
    if (opts.csrf !== false && this.csrf && method !== 'GET') headers['x-csrf-token'] = this.csrf;
    let body: RequestInit['body'] | undefined;
    if (opts.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.json);
    } else if (opts.body !== undefined) body = opts.body as RequestInit['body'];
    const res = await fetch(this.h.base + p, { method, headers, body, redirect: 'manual' });
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(';');
      const [k, ...v] = pair!.split('=');
      const value = v.join('=');
      if (!value || /max-age=0/i.test(sc) || /expires=thu, 01 jan 1970/i.test(sc)) this.cookies.delete(k!.trim());
      else this.cookies.set(k!.trim(), value);
    }
    const type = res.headers.get('content-type') ?? '';
    const parsed = type.includes('application/json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, body: parsed as T, headers: res.headers };
  }
  get<T = any>(p: string, o?: Parameters<Client['req']>[2]) {
    return this.req<T>('GET', p, o);
  }
  post<T = any>(p: string, json?: unknown, o: Parameters<Client['req']>[2] = {}) {
    return this.req<T>('POST', p, { json: json ?? {}, ...o });
  }
  patch<T = any>(p: string, json: unknown, o: Parameters<Client['req']>[2] = {}) {
    return this.req<T>('PATCH', p, { json, ...o });
  }
  put<T = any>(p: string, json: unknown) {
    return this.req<T>('PUT', p, { json });
  }
  del<T = any>(p: string, json?: unknown) {
    return this.req<T>('DELETE', p, json === undefined ? {} : { json });
  }

  async requestCode(email: string, purpose: 'register' | 'login' = 'register') {
    const since = Date.now() - 5;
    const r = await this.post('/api/auth/otp', { email, purpose });
    if (r.status !== 200) throw new Error(`otp request failed ${r.status} ${JSON.stringify(r.body)}`);
    const mail = await this.h.sink.next(email, since);
    return { challengeId: r.body.challengeId as string, mail, code: SmtpSink.codeIn(mail) };
  }

  async verify(challengeId: string, code: string) {
    const r = await this.post('/api/auth/verify', { challengeId, code });
    if (r.status === 200) {
      this.csrf = r.body.csrfToken;
      this.me = r.body.me;
    }
    return r;
  }

  async signIn(email: string, purpose: 'register' | 'login' = 'login') {
    const { challengeId, code } = await this.requestCode(email, purpose);
    const r = await this.verify(challengeId, code!);
    if (r.status !== 200) throw new Error(`verify failed ${r.status} ${JSON.stringify(r.body)}`);
    return r;
  }

  /** Register a brand-new account and finish profile setup. */
  async register(username: string, opts: { displayName?: string; privacy?: Record<string, unknown>; keys?: boolean } = {}) {
    const email = `${username.replace(/[^a-z0-9]/g, '')}.${randomUUID().slice(0, 6)}@gmail.com`;
    await this.signIn(email, 'register');
    const p = await this.patch('/api/me/profile', { username, displayName: opts.displayName ?? username });
    if (p.status !== 200) throw new Error(`profile failed ${p.status} ${JSON.stringify(p.body)}`);
    this.me = p.body.me;
    if (opts.privacy) {
      const r = await this.patch('/api/me/privacy', opts.privacy);
      this.me = r.body.me;
    }
    if (opts.keys !== false) await this.setupKeys();
    return { email, id: this.me.id as string };
  }

  get id(): string {
    return this.me.id;
  }

  async connect(opts: { autoAck?: boolean; origin?: string } = {}): Promise<TestSocket> {
    const s = new TestSocket(this.h.base.replace('http', 'ws') + '/ws', { cookie: this.cookieHeader(), origin: opts.origin ?? this.h.origin ?? ORIGIN }, opts.autoAck ?? true);
    await s.opened;
    this.sockets.push(s);
    return s;
  }

  closeSockets() {
    for (const s of this.sockets) s.close();
    this.sockets = [];
  }
}

export class TestSocket {
  ws: WebSocket;
  events: { event: string; data: any }[] = [];
  opened: Promise<void>;
  closed: Promise<{ code: number; reason: string }>;
  private waiters: { event: string; pred: (d: any) => boolean; resolve: (d: any) => void }[] = [];

  constructor(url: string, headers: Record<string, string>, public autoAck: boolean) {
    this.ws = new WebSocket(url, { headers });
    this.opened = new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('unexpected-response', (_req, res) => reject(new Error(`ws rejected ${res.statusCode}`)));
      this.ws.once('error', reject);
    });
    this.closed = new Promise((resolve) => this.ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type !== 'event') return;
      if (msg.ackId && this.autoAck) this.ws.send(JSON.stringify({ type: 'ack', ackId: msg.ackId }));
      const w = this.waiters.find((x) => x.event === msg.event && x.pred(msg.data));
      if (w) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(msg.data);
      } else {
        this.events.push({ event: msg.event, data: msg.data });
      }
    });
  }

  send(obj: unknown) {
    this.ws.send(JSON.stringify(obj));
  }

  waitFor(event: string, pred: (d: any) => boolean = () => true, timeoutMs = 4000): Promise<any> {
    const existing = this.events.find((e) => e.event === event && pred(e.data));
    if (existing) {
      this.events.splice(this.events.indexOf(existing), 1);
      return Promise.resolve(existing.data);
    }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
      this.waiters.push({ event, pred, resolve: (d) => (clearTimeout(t), resolve(d)) });
    });
  }

  /** Resolve true if no matching event arrives within the window. */
  async expectNone(event: string, pred: (d: any) => boolean = () => true, windowMs = 400) {
    try {
      await this.waitFor(event, pred, windowMs);
      return false;
    } catch {
      return true;
    }
  }

  close() {
    this.ws.close();
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Two registered users who already share an accepted conversation. */
export async function connectedPair(h: Harness, names: [string, string] = ['alice', 'bob']) {
  const a = new Client(h);
  const b = new Client(h);
  await a.register(names[0], { privacy: { whoCanMessage: 'everyone' } });
  await b.register(names[1], { privacy: { whoCanMessage: 'everyone' } });
  const r = await a.post('/api/conversations', { userId: b.id });
  if (r.status !== 200) throw new Error(`conversation failed ${JSON.stringify(r.body)}`);
  return { a, b, conversationId: r.body.conversation.id as string };
}
