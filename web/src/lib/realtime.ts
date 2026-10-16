type Handler = (event: string, data: any) => void;
type StatusHandler = (status: 'connecting' | 'online' | 'offline', info?: { firstConnect: boolean }) => void;

/**
 * WebSocket client with automatic reconnection (exponential backoff with jitter), heartbeat,
 * delivery acknowledgements and page-visibility reporting. After every reconnect the app resyncs
 * over HTTP, so nothing sent while the socket was down is lost.
 */
export class RealtimeClient {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private timer: number | undefined;
  private heartbeat: number | undefined;
  private stopped = true;
  private connectedOnce = false;
  private lastPong = Date.now();

  constructor(private onEvent: Handler, private onStatus: StatusHandler) {
    document.addEventListener('visibilitychange', this.sendVisibility);
    window.addEventListener('online', this.kick);
    window.addEventListener('offline', () => this.onStatus('offline'));
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.heartbeat);
    this.ws?.close(1000);
    this.ws = null;
    this.connectedOnce = false;
  }

  private kick = () => {
    if (this.stopped) return;
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    clearTimeout(this.timer);
    this.attempt = 0;
    this.connect();
  };

  private connect() {
    if (this.stopped) return;
    this.onStatus('connecting');
    const url = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      const first = !this.connectedOnce;
      this.connectedOnce = true;
      this.attempt = 0;
      this.lastPong = Date.now();
      this.onStatus('online', { firstConnect: first });
      this.sendVisibility();
      clearInterval(this.heartbeat);
      this.heartbeat = window.setInterval(() => {
        if (Date.now() - this.lastPong > 70_000) {
          ws.close(4000, 'heartbeat timeout');
          return;
        }
        this.send({ type: 'ping' });
      }, 25_000);
    };
    ws.onmessage = (e) => {
      let msg: any;
      try {
        msg = JSON.parse(e.data as string);
      } catch {
        return;
      }
      this.lastPong = Date.now();
      if (msg.type === 'event') {
        if (msg.ackId) this.send({ type: 'ack', ackId: msg.ackId });
        this.onEvent(msg.event, msg.data);
      }
    };
    ws.onclose = (e) => {
      clearInterval(this.heartbeat);
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.stopped) return;
      this.onStatus(navigator.onLine ? 'connecting' : 'offline');
      if (e.code === 4001) return; // session revoked: the app handles sign-out
      const delay = Math.min(30_000, 1000 * 2 ** this.attempt) * (0.6 + Math.random() * 0.8);
      this.attempt++;
      this.timer = window.setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => ws.close();
  }

  send(obj: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  private sendVisibility = () => this.send({ type: 'visibility', visible: document.visibilityState === 'visible' });

  typing(conversationId: string, typing: boolean) {
    this.send({ type: 'typing', conversationId, typing });
  }
}
