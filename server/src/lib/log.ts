/**
 * Minimal structured (JSON-lines) logger.
 * Sensitive keys are redacted defensively so OTPs, tokens and cookies never reach logs
 * even if a caller passes them by mistake.
 */
type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SENSITIVE = /^(code|otp\w*|\w*token|cookie|set-cookie|password|pass|\w*secret|authorization|p256dh|auth|csrf\w*|body|email)$/i;

let minLevel: Level = 'info';
let silent = false;

export function configureLogger(opts: { level: Level; silent?: boolean }) {
  minLevel = opts.level;
  silent = !!opts.silent;
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack, code: (value as { code?: unknown }).code };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE.test(k) ? '[redacted]' : redact(v, depth + 1);
  return out;
}

function write(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (silent || order[level] < order[minLevel]) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(fields ? (redact(fields) as object) : {}) });
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

export const log = {
  debug: (msg: string, f?: Record<string, unknown>) => write('debug', msg, f),
  info: (msg: string, f?: Record<string, unknown>) => write('info', msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => write('warn', msg, f),
  error: (msg: string, f?: Record<string, unknown>) => write('error', msg, f),
};
