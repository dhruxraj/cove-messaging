import { loadConfig } from '../config';
import { Database, migrate } from '../db';
import { configureLogger } from '../lib/log';

const cfg = loadConfig();
configureLogger({ level: cfg.LOG_LEVEL });
const db = new Database(cfg);
try {
  const applied = await migrate(db);
  console.log(applied.length ? `Applied ${applied.length} migration(s): ${applied.join(', ')}` : 'Database is up to date.');
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await db.close();
}
