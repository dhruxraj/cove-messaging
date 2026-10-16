import { createApp } from './app';
import { loadConfig } from './config';
import { configureLogger, log } from './lib/log';

const cfg = loadConfig();
configureLogger({ level: cfg.LOG_LEVEL });

const instance = await createApp(cfg, { runMigrations: process.env.RUN_MIGRATIONS !== 'false' });
await instance.listen();

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info('shutting down', { signal });
  const force = setTimeout(() => process.exit(1), 15_000);
  force.unref();
  await instance.close().catch((err) => log.error('shutdown error', { err }));
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (err) => log.error('unhandled rejection', { err }));
