import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { authRoutes } from './auth/routes';
import type { Config } from './config';
import type { AppContext, HonoEnv } from './context';
import { conversationRoutes } from './conversations/routes';
import { Database, migrate } from './db';
import { e2eeRoutes } from './e2ee/routes';
import { CleanupJob } from './jobs/cleanup';
import { ApiError } from './lib/errors';
import { baseMiddleware, errorResponse, originGuard, requireAuth } from './lib/http';
import { log } from './lib/log';
import { createMailer, type Mailer } from './lib/mailer';
import { RateLimiter } from './lib/rate-limit';
import { mediaRoutes } from './media/routes';
import { MediaProcessor } from './media/process';
import { LocalStorage } from './media/storage';
import { messageRoutes } from './messages/routes';
import { PushService } from './notifications/push';
import { notificationRoutes } from './notifications/routes';
import { realtimeHooks } from './realtime/handlers';
import { RealtimeHub } from './realtime/hub';
import { userRoutes } from './users/routes';

/** Routes reachable without a session. Everything else under /api requires one (secure by default). */
const PUBLIC_API = new Set(['/api/health', '/api/auth/config', '/api/auth/otp', '/api/auth/verify', '/api/auth/session']);

export interface AppInstance {
  app: Hono<HonoEnv>;
  ctx: AppContext;
  cleanup: CleanupJob;
  listen(port?: number, host?: string): Promise<{ server: Server; port: number }>;
  close(): Promise<void>;
}

export async function createApp(cfg: Config, opts: { mailer?: Mailer; runMigrations?: boolean } = {}): Promise<AppInstance> {
  const db = new Database(cfg);
  if (opts.runMigrations !== false) await migrate(db);
  const storage = new LocalStorage(cfg.storageDir);
  await storage.init();
  const hub = new RealtimeHub({ allowedOrigin: cfg.APP_ORIGIN });
  const ctx: AppContext = {
    cfg,
    db,
    mailer: opts.mailer ?? createMailer(cfg),
    limiter: new RateLimiter(db),
    storage,
    hub,
    push: new PushService(cfg, db),
  };
  const media = new MediaProcessor(cfg, () => storage.tempPath());
  const app = new Hono<HonoEnv>();

  app.onError(errorResponse);
  app.use('*', baseMiddleware(ctx));
  app.use('/api/*', originGuard(ctx));
  const auth = requireAuth(ctx);
  app.use('/api/*', async (c, next) => (PUBLIC_API.has(c.req.path) ? next() : auth(c, next)));

  const api = new Hono<HonoEnv>();
  api.get('/health', async (c) => {
    await db.query('SELECT 1');
    return c.json({ ok: true });
  });
  /** Non-secret settings the sign-in screen needs (which email domains are accepted, code lifetime). */
  api.get('/auth/config', (c) =>
    c.json({
      appName: cfg.APP_NAME,
      allowedEmailDomains: cfg.ALLOWED_EMAIL_DOMAINS,
      otpTtlSeconds: cfg.OTP_TTL_SECONDS,
      otpMaxAttempts: cfg.OTP_MAX_ATTEMPTS,
      sessionPolicy: cfg.SESSION_POLICY,
    }),
  );
  api.route('/', authRoutes(ctx));
  api.route('/', userRoutes(ctx, media));
  api.route('/', conversationRoutes(ctx));
  api.route('/', messageRoutes(ctx));
  api.route('/', mediaRoutes(ctx, media));
  api.route('/', notificationRoutes(ctx));
  api.route('/', e2eeRoutes(ctx));
  api.all('*', () => {
    throw new ApiError(404, 'not_found', 'Not found.');
  });
  app.route('/api', api);

  // Built web client (single-page app). Hashed assets are immutable; HTML and the service worker are not cached.
  const dist = cfg.webDistDir;
  if (dist && fs.existsSync(path.join(dist, 'index.html'))) {
    const root = path.relative(process.cwd(), dist) || '.';
    const indexHtml = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
    app.use(
      '/*',
      serveStatic({
        root,
        onFound: (p, c) => {
          c.header('Cache-Control', p.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
          if (p.endsWith('sw.js')) c.header('Service-Worker-Allowed', '/');
        },
      }),
    );
    app.get('*', (c) => {
      c.header('Cache-Control', 'no-cache');
      return c.html(indexHtml);
    });
  }

  const cleanup = new CleanupJob(ctx);
  let server: Server | undefined;

  return {
    app,
    ctx,
    cleanup,
    listen(port = cfg.PORT, host = cfg.HOST) {
      return new Promise((resolve) => {
        const s = serve({ fetch: app.fetch, port, hostname: host }, (info: AddressInfo) => {
          server = s as Server;
          server.headersTimeout = 30_000;
          server.requestTimeout = 0; // long uploads are bounded by size limits instead
          server.keepAliveTimeout = 65_000;
          hub.attach(server, realtimeHooks(ctx));
          cleanup.start();
          log.info('listening', { port: info.port, origin: cfg.APP_ORIGIN });
          resolve({ server, port: info.port });
        }) as Server;
      });
    },
    async close() {
      cleanup.stop();
      await hub.close();
      if (server) await new Promise<void>((r) => server!.close(() => r()));
      ctx.mailer.close();
      await db.close();
    },
  };
}
