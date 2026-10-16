import path from 'node:path';
import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no'])
    .optional()
    .transform((v) => (v === undefined ? def : ['true', '1', 'yes'].includes(v)));

const int = (def: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max).default(def);

const DEV_SECRET = 'dev-only-insecure-secret-change-me-0123456789';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_NAME: z.string().min(1).max(40).default('Cove'),
  HOST: z.string().default('0.0.0.0'),
  PORT: int(8080, 0, 65535),
  /** Public origin users load the app from, e.g. https://chat.example.com (no trailing slash). */
  APP_ORIGIN: z.string().url().default('http://localhost:8080'),
  /** Set when running behind exactly one reverse proxy (Caddy/nginx) that appends X-Forwarded-For. */
  TRUST_PROXY: bool(false),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  DATABASE_URL: z.string().min(1).default('postgres://postgres:devpassword@127.0.0.1:5432/cove_dev'),
  DATABASE_SSL: z.enum(['disable', 'require', 'verify-full']).default('disable'),
  DATABASE_POOL_MAX: int(10, 1, 200),

  SESSION_SECRET: z.string().min(32).default(DEV_SECRET),
  OTP_PEPPER: z.string().min(32).default(DEV_SECRET),

  SMTP_HOST: z.string().default('127.0.0.1'),
  SMTP_PORT: int(1025, 1, 65535),
  /** true = implicit TLS (port 465). false = plain connection upgraded with STARTTLS when offered. */
  SMTP_SECURE: bool(false),
  /** Refuse to send unless the connection is encrypted (STARTTLS required). Defaults on in production. */
  SMTP_REQUIRE_TLS: z.enum(['true', 'false']).optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().default('Cove <no-reply@localhost>'),

  ALLOWED_EMAIL_DOMAINS: z
    .string()
    .default('gmail.com')
    .transform((s) => s.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean)),
  OTP_TTL_SECONDS: int(300, 60, 3600),
  OTP_MAX_ATTEMPTS: int(5, 1, 20),
  OTP_RESEND_COOLDOWN_SECONDS: int(60, 0, 3600),
  OTP_MAX_PER_HOUR: int(5, 1, 100),
  OTP_MAX_FAILURES_PER_HOUR: int(15, 1, 1000),
  /** Code requests per client IP per hour, and verification attempts per IP per 15 minutes. */
  OTP_IP_MAX_PER_HOUR: int(30, 1, 100000),
  OTP_VERIFY_IP_MAX_PER_15MIN: int(60, 1, 100000),

  /** single = one active session per account (a new sign-in ends the previous one). */
  SESSION_POLICY: z.enum(['single', 'multiple']).default('single'),
  SESSION_TTL_DAYS: int(30, 1, 365),
  SESSION_IDLE_DAYS: int(14, 1, 365),

  STORAGE_DIR: z.string().default('./data/storage'),
  MAX_IMAGE_MB: int(16, 1, 200),
  MAX_VIDEO_MB: int(64, 1, 2048),
  MAX_AUDIO_MB: int(16, 1, 500),
  MAX_FILE_MB: int(32, 1, 2048),
  MAX_AVATAR_MB: int(8, 1, 50),
  MAX_PROTECTED_MB: int(64, 1, 512),
  MAX_VIDEO_SECONDS: int(600, 1, 7200),
  MAX_AUDIO_SECONDS: int(1800, 1, 14400),
  FFMPEG_PATH: z.string().default('ffmpeg'),
  FFPROBE_PATH: z.string().default('ffprobe'),

  MESSAGE_EDIT_WINDOW_MINUTES: int(15, 0, 10080),
  MESSAGE_DELETE_WINDOW_MINUTES: int(2880, 0, 525600),
  PROTECTED_MEDIA_TTL_DAYS: int(14, 1, 365),
  VIEW_SESSION_SECONDS: int(300, 30, 3600),
  CLEANUP_INTERVAL_SECONDS: int(30, 5, 3600),

  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().optional(),

  /** Serve the built web client from this directory (empty = API only). */
  WEB_DIST_DIR: z.string().default('../web/dist'),
});

export type Config = z.infer<typeof schema> & {
  isProd: boolean;
  isTest: boolean;
  secureCookies: boolean;
  wsOrigin: string;
  storageDir: string;
  webDistDir: string;
  smtpRequireTls: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const c = parsed.data;
  const origin = new URL(c.APP_ORIGIN);
  const isProd = c.NODE_ENV === 'production';
  const cfg: Config = {
    ...c,
    APP_ORIGIN: origin.origin,
    isProd,
    isTest: c.NODE_ENV === 'test',
    secureCookies: origin.protocol === 'https:',
    wsOrigin: `${origin.protocol === 'https:' ? 'wss:' : 'ws:'}//${origin.host}`,
    storageDir: path.resolve(c.STORAGE_DIR),
    webDistDir: c.WEB_DIST_DIR ? path.resolve(c.WEB_DIST_DIR) : '',
    smtpRequireTls: c.SMTP_REQUIRE_TLS ? c.SMTP_REQUIRE_TLS === 'true' : isProd && !c.SMTP_SECURE,
  };

  if (isProd) {
    const problems: string[] = [];
    if (origin.protocol !== 'https:') problems.push('APP_ORIGIN must use https in production');
    if (c.SESSION_SECRET === DEV_SECRET) problems.push('SESSION_SECRET must be set to a unique random value');
    if (c.OTP_PEPPER === DEV_SECRET) problems.push('OTP_PEPPER must be set to a unique random value');
    if (c.SESSION_SECRET === c.OTP_PEPPER) problems.push('SESSION_SECRET and OTP_PEPPER must differ');
    if (!env.SMTP_HOST) problems.push('SMTP_HOST must be configured');
    if (!env.DATABASE_URL) problems.push('DATABASE_URL must be configured');
    if (problems.length) throw new Error(`Refusing to start in production:\n  ${problems.join('\n  ')}`);
  }
  return cfg;
}
