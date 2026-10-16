import type { Config } from './config';
import type { Database } from './db';
import type { Mailer } from './lib/mailer';
import type { RateLimiter } from './lib/rate-limit';
import type { Storage } from './media/storage';
import type { RealtimeHub } from './realtime/hub';
import type { PushService } from './notifications/push';

/** Everything a request handler or job needs. Built once in app.ts. */
export interface AppContext {
  cfg: Config;
  db: Database;
  mailer: Mailer;
  limiter: RateLimiter;
  storage: Storage;
  hub: RealtimeHub;
  push: PushService;
}

export interface AuthInfo {
  userId: string;
  sessionId: string;
  token: string;
}

export type HonoEnv = {
  Variables: {
    auth: AuthInfo;
    ip: string;
    requestId: string;
  };
};
