import type { AppContext } from '../context';
import type { Queryable } from '../db';

export type NotificationType =
  | 'conversation_request'
  | 'request_accepted'
  | 'security_session_replaced'
  | 'security_sessions_ended';

export interface NotificationRow {
  id: string;
  type: NotificationType;
  payload: Record<string, unknown>;
  created_at: Date;
  read_at: Date | null;
}

export const serializeNotification = (n: NotificationRow) => ({
  id: n.id,
  type: n.type,
  payload: n.payload,
  createdAt: n.created_at.toISOString(),
  read: !!n.read_at,
});

/** Persist an in-app notification and push it to the user's open tabs. */
export async function notify(ctx: AppContext, userId: string, type: NotificationType, payload: Record<string, unknown>, db: Queryable = ctx.db) {
  const r = await db.query<NotificationRow>(
    `INSERT INTO notifications (user_id, type, payload) VALUES ($1, $2, $3)
     RETURNING id, type, payload, created_at, read_at`,
    [userId, type, payload],
  );
  const row = r.rows[0]!;
  ctx.hub.emitToUser(userId, 'notification:new', serializeNotification(row));
  return row;
}
