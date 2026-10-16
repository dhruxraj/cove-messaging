import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { uuid } from '../lib/crypto';
import { log } from '../lib/log';

export interface RealtimeClient {
  id: string;
  ws: WebSocket;
  userId: string;
  sessionId: string;
  alive: boolean;
  visible: boolean;
}

export interface HubHooks {
  /** Authenticate an upgrade request; return null to reject. */
  authenticate(req: IncomingMessage): Promise<{ userId: string; sessionId: string } | null>;
  /** Check which of the given session ids are still valid. */
  validSessions(sessionIds: string[]): Promise<Set<string>>;
  onFirstConnection(userId: string): void;
  onLastDisconnect(userId: string): void;
  onClientMessage(client: RealtimeClient, msg: Record<string, unknown>): void;
}

type Pending = { resolve: (acked: boolean) => void; timer: NodeJS.Timeout };

const MAX_BUFFERED = 2 * 1024 * 1024;

/**
 * WebSocket fan-out for one server process. Events are pushed per user (all of that user's
 * tabs); delivery acknowledgements are collected for message receipts.
 *
 * Note: state is in memory. Running several replicas requires a shared pub/sub (e.g. Postgres
 * LISTEN/NOTIFY or Redis) — see docs/ARCHITECTURE.md.
 */
export class RealtimeHub {
  private wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: false });
  private byUser = new Map<string, Set<RealtimeClient>>();
  private bySession = new Map<string, Set<RealtimeClient>>();
  private pending = new Map<string, Pending>();
  private heartbeat?: NodeJS.Timeout;
  private revalidate?: NodeJS.Timeout;
  private hooks?: HubHooks;

  constructor(private opts: { allowedOrigin: string; path?: string }) {}

  attach(server: Server, hooks: HubHooks) {
    this.hooks = hooks;
    server.on('upgrade', (req, socket, head) => void this.handleUpgrade(req, socket, head));
    this.heartbeat = setInterval(() => this.tick(), 25_000);
    this.revalidate = setInterval(() => void this.revalidateSessions(), 60_000);
    this.heartbeat.unref();
    this.revalidate.unref();
  }

  private reject(socket: Duplex, status: number, text: string) {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  }

  private async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    socket.on('error', () => socket.destroy());
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname !== (this.opts.path ?? '/ws')) return this.reject(socket, 404, 'Not Found');
      // Cross-site WebSocket hijacking protection: browsers always send Origin on WS upgrades.
      if (req.headers.origin !== this.opts.allowedOrigin) return this.reject(socket, 403, 'Forbidden');
      const auth = await this.hooks!.authenticate(req);
      if (!auth) return this.reject(socket, 401, 'Unauthorized');
      this.wss.handleUpgrade(req, socket, head, (ws) => this.register(ws, auth.userId, auth.sessionId));
    } catch (err) {
      log.warn('websocket upgrade failed', { err });
      this.reject(socket, 500, 'Internal Server Error');
    }
  }

  private register(ws: WebSocket, userId: string, sessionId: string) {
    const client: RealtimeClient = { id: uuid(), ws, userId, sessionId, alive: true, visible: true };
    const userSet = this.byUser.get(userId) ?? new Set();
    const first = userSet.size === 0;
    userSet.add(client);
    this.byUser.set(userId, userSet);
    const sessSet = this.bySession.get(sessionId) ?? new Set();
    sessSet.add(client);
    this.bySession.set(sessionId, sessSet);

    ws.on('pong', () => (client.alive = true));
    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      const m = msg as Record<string, unknown>;
      if (m.type === 'ack' && typeof m.ackId === 'string') return this.resolveAck(m.ackId);
      if (m.type === 'ping') return this.sendRaw(client, { type: 'pong' });
      if (m.type === 'visibility') {
        client.visible = m.visible === true;
        return;
      }
      try {
        this.hooks!.onClientMessage(client, m);
      } catch (err) {
        log.warn('realtime handler error', { err });
      }
    });
    ws.on('close', () => this.unregister(client));
    ws.on('error', () => ws.terminate());

    this.sendRaw(client, { type: 'hello', clientId: client.id });
    if (first) this.hooks!.onFirstConnection(userId);
  }

  private unregister(client: RealtimeClient) {
    const set = this.byUser.get(client.userId);
    if (set?.delete(client) && set.size === 0) {
      this.byUser.delete(client.userId);
      this.hooks?.onLastDisconnect(client.userId);
    }
    const s = this.bySession.get(client.sessionId);
    if (s?.delete(client) && s.size === 0) this.bySession.delete(client.sessionId);
  }

  private sendRaw(client: RealtimeClient, frame: object): boolean {
    if (client.ws.readyState !== WebSocket.OPEN) return false;
    if (client.ws.bufferedAmount > MAX_BUFFERED) {
      // Slow consumer: drop it; it will reconnect and resync over HTTP.
      client.ws.terminate();
      return false;
    }
    client.ws.send(JSON.stringify(frame));
    return true;
  }

  emitToUser(userId: string, event: string, data: unknown) {
    for (const c of this.byUser.get(userId) ?? []) this.sendRaw(c, { type: 'event', event, data });
  }

  emitToSession(sessionId: string, event: string, data: unknown) {
    for (const c of this.bySession.get(sessionId) ?? []) this.sendRaw(c, { type: 'event', event, data });
  }

  /** Emit and resolve true as soon as any of the user's clients acknowledges receipt. */
  emitToUserWithAck(userId: string, event: string, data: unknown, timeoutMs = 10_000): Promise<boolean> {
    const clients = [...(this.byUser.get(userId) ?? [])];
    if (!clients.length) return Promise.resolve(false);
    const ackId = uuid();
    const p = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(ackId);
        resolve(false);
      }, timeoutMs);
      timer.unref();
      this.pending.set(ackId, { resolve, timer });
    });
    let sent = false;
    for (const c of clients) sent = this.sendRaw(c, { type: 'event', event, data, ackId }) || sent;
    if (!sent) this.resolveAck(ackId, false);
    return p;
  }

  private resolveAck(ackId: string, acked = true) {
    const p = this.pending.get(ackId);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(ackId);
    p.resolve(acked);
  }

  isOnline(userId: string) {
    return (this.byUser.get(userId)?.size ?? 0) > 0;
  }

  hasVisibleClient(userId: string) {
    for (const c of this.byUser.get(userId) ?? []) if (c.visible) return true;
    return false;
  }

  /** Tell a session's tabs why they are being signed out, then close them. */
  disconnectSession(sessionId: string, reason: string) {
    for (const c of [...(this.bySession.get(sessionId) ?? [])]) {
      this.sendRaw(c, { type: 'event', event: 'session:revoked', data: { reason } });
      c.ws.close(4001, reason);
    }
  }

  disconnectUser(userId: string, reason: string) {
    for (const c of [...(this.byUser.get(userId) ?? [])]) {
      this.sendRaw(c, { type: 'event', event: 'session:revoked', data: { reason } });
      c.ws.close(4001, reason);
    }
  }

  private tick() {
    for (const set of this.byUser.values()) {
      for (const c of set) {
        if (!c.alive) {
          c.ws.terminate();
          continue;
        }
        c.alive = false;
        try {
          c.ws.ping();
        } catch {
          c.ws.terminate();
        }
      }
    }
  }

  private async revalidateSessions() {
    const ids = [...this.bySession.keys()];
    if (!ids.length || !this.hooks) return;
    try {
      const valid = await this.hooks.validSessions(ids);
      for (const id of ids) if (!valid.has(id)) this.disconnectSession(id, 'expired');
    } catch (err) {
      log.warn('session revalidation failed', { err });
    }
  }

  connectionCount() {
    let n = 0;
    for (const s of this.byUser.values()) n += s.size;
    return n;
  }

  async close() {
    clearInterval(this.heartbeat);
    clearInterval(this.revalidate);
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    for (const set of this.byUser.values()) for (const c of set) c.ws.terminate();
    await new Promise<void>((r) => this.wss.close(() => r()));
  }
}
