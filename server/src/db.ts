import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Config } from './config';
import { log } from './lib/log';

/** Anything that can run a parameterised query: the pool wrapper or a transaction client. */
export interface Queryable {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query<T extends pg.QueryResultRow = any>(sql: string, params?: unknown[]): Promise<pg.QueryResult<T>>;
}

export class Database {
  readonly pool: pg.Pool;

  constructor(cfg: Pick<Config, 'DATABASE_URL' | 'DATABASE_SSL' | 'DATABASE_POOL_MAX'>) {
    this.pool = new pg.Pool({
      connectionString: cfg.DATABASE_URL,
      max: cfg.DATABASE_POOL_MAX,
      ssl:
        cfg.DATABASE_SSL === 'disable'
          ? undefined
          : { rejectUnauthorized: cfg.DATABASE_SSL === 'verify-full' },
      idleTimeoutMillis: 30_000,
      statement_timeout: 15_000,
      application_name: 'cove',
    });
    this.pool.on('error', (err) => log.error('postgres pool error', { err }));
  }

  async query<T extends pg.QueryResultRow = Record<string, unknown>>(sql: string, params: unknown[] = []) {
    return this.pool.query<T>(sql, params);
  }

  async one<T extends pg.QueryResultRow = Record<string, unknown>>(sql: string, params: unknown[] = []) {
    const r = await this.pool.query<T>(sql, params);
    return r.rows[0];
  }

  /** Run fn inside a transaction. Rolls back on any thrown error. */
  async tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* connection may already be broken */
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool.end();
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));

/** Locate the migrations directory both from src/ (tsx) and dist/ (bundled). */
async function migrationsDir(): Promise<string> {
  for (const candidate of [path.join(here, '../migrations'), path.join(here, 'migrations')]) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      /* try next */
    }
  }
  throw new Error('migrations directory not found');
}

/** Apply pending SQL migrations in order. Each migration runs in its own transaction. */
export async function migrate(db: Database): Promise<string[]> {
  const dir = await migrationsDir();
  const files = (await fs.readdir(dir)).filter((f) => /^\d{3,}_.+\.sql$/.test(f)).sort();
  const client = await db.pool.connect();
  const applied: string[] = [];
  try {
    // Serialize concurrent migrators (e.g. several replicas starting at once).
    await client.query('SELECT pg_advisory_lock(727001)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const done = new Set((await client.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map((r) => r.version));
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await fs.readFile(path.join(dir, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
        log.info('migration applied', { file });
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => {});
    client.release();
  }
  return applied;
}
