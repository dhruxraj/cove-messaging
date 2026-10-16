import webpush from 'web-push';
import type { Config } from '../config';
import type { Database } from '../db';
import { log } from '../lib/log';

export interface PushPayload {
  title: string;
  body: string;
  tag?: string;
  url?: string;
}

/**
 * Web Push (RFC 8030/8291) with VAPID. Payloads are end-to-end encrypted to the browser by the
 * Web Push protocol, so the browser vendor's push service cannot read them. By default we still
 * send no message content (see user_notification_settings.push_show_preview).
 */
export class PushService {
  readonly enabled: boolean;

  constructor(private cfg: Config, private db: Database) {
    this.enabled = !!(cfg.VAPID_PUBLIC_KEY && cfg.VAPID_PRIVATE_KEY);
  }

  publicKey() {
    return this.enabled ? this.cfg.VAPID_PUBLIC_KEY! : null;
  }

  async sendToUser(userId: string, payload: PushPayload): Promise<number> {
    if (!this.enabled) return 0;
    const subs = await this.db.query<{ id: string; endpoint: string; p256dh: string; auth: string }>(
      `SELECT s.id, s.endpoint, s.p256dh, s.auth FROM push_subscriptions s
       JOIN sessions se ON se.id = s.session_id AND se.revoked_at IS NULL AND se.expires_at > now()
       WHERE s.user_id = $1`,
      [userId],
    );
    let sent = 0;
    await Promise.all(
      subs.rows.map(async (s) => {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), {
            TTL: 3600,
            urgency: 'high',
            topic: payload.tag?.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || undefined,
            vapidDetails: {
              subject: this.cfg.VAPID_SUBJECT || `${this.cfg.APP_ORIGIN}`,
              publicKey: this.cfg.VAPID_PUBLIC_KEY!,
              privateKey: this.cfg.VAPID_PRIVATE_KEY!,
            },
            timeout: 10_000,
          });
          sent++;
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            await this.db.query('DELETE FROM push_subscriptions WHERE id = $1', [s.id]);
          } else {
            log.warn('push delivery failed', { status });
          }
        }
      }),
    );
    return sent;
  }
}
