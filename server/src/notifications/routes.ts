import { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext, HonoEnv } from '../context';
import { badRequest } from '../lib/errors';
import { body } from '../lib/http';
import { serializeNotification, type NotificationRow } from './service';

/**
 * Push endpoints are URLs the server will POST to, so they are restricted to known browser push
 * services to prevent server-side request forgery.
 */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];

export function isAllowedPushEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && !u.port && PUSH_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

export function notificationRoutes(ctx: AppContext) {
  const app = new Hono<HonoEnv>();
  const { db } = ctx;

  app.get('/notifications', async (c) => {
    const { userId } = c.get('auth');
    const r = await db.query<NotificationRow>(
      'SELECT id::text, type, payload, created_at, read_at FROM notifications WHERE user_id = $1 ORDER BY id DESC LIMIT 50',
      [userId],
    );
    const unread = await db.one<{ n: number }>('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [userId]);
    return c.json({ notifications: r.rows.map(serializeNotification), unreadCount: unread?.n ?? 0 });
  });

  app.post('/notifications/read', async (c) => {
    const { userId } = c.get('auth');
    const { ids } = await body(c, z.object({ ids: z.array(z.string().regex(/^\d+$/)).max(200).optional() }));
    if (ids?.length) {
      await db.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND id = ANY($2::bigint[]) AND read_at IS NULL', [userId, ids]);
    } else {
      await db.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [userId]);
    }
    return c.json({ ok: true });
  });

  app.post('/push/subscriptions', async (c) => {
    const { userId, sessionId } = c.get('auth');
    if (!ctx.push.enabled) throw badRequest('Push notifications are not configured on this server.', 'push_disabled');
    const input = await body(
      c,
      z.object({
        endpoint: z.string().url().max(2048),
        keys: z.object({ p256dh: z.string().min(16).max(256), auth: z.string().min(8).max(64) }),
      }),
    );
    if (!isAllowedPushEndpoint(input.endpoint)) throw badRequest('Unsupported push service.', 'invalid_endpoint');
    await db.query(
      `INSERT INTO push_subscriptions (user_id, session_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, session_id = EXCLUDED.session_id,
         p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, created_at = now()`,
      [userId, sessionId, input.endpoint, input.keys.p256dh, input.keys.auth],
    );
    await db.query('UPDATE user_notification_settings SET push_enabled = true, updated_at = now() WHERE user_id = $1', [userId]);
    return c.json({ ok: true });
  });

  app.delete('/push/subscriptions', async (c) => {
    const { userId } = c.get('auth');
    const { endpoint } = await body(c, z.object({ endpoint: z.string().max(2048).optional() }));
    if (endpoint) await db.query('DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2', [userId, endpoint]);
    else await db.query('DELETE FROM push_subscriptions WHERE user_id = $1', [userId]);
    return c.json({ ok: true });
  });

  return app;
}
