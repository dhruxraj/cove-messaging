import { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext, HonoEnv } from '../context';
import { ApiError, notFound } from '../lib/errors';
import { body, zUuid } from '../lib/http';
import { broadcastMessage, insertSystemMessage } from '../messages/service';
import { contactIds } from '../users/access';
import { buildMe } from '../users/me';
import { backupSchema, verifyPublicKey, type KeyBackup } from './keys';

interface KeyRow {
  kid: string;
  public_key: string;
  created_at: Date;
  superseded_at: Date | null;
}

const serializeKey = (k: KeyRow) => ({ kid: k.kid, publicKey: k.public_key, createdAt: k.created_at.toISOString(), active: !k.superseded_at });

export function e2eeRoutes(ctx: AppContext) {
  const app = new Hono<HonoEnv>();
  const { db } = ctx;

  /** My public keys (newest first). */
  app.get('/me/keys', async (c) => {
    const { userId } = c.get('auth');
    const r = await db.query<KeyRow>('SELECT kid, public_key, created_at, superseded_at FROM user_keys WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100', [userId]);
    const hasBackup = !!(await db.one('SELECT 1 FROM key_backups WHERE user_id = $1', [userId]));
    return c.json({ keys: r.rows.map(serializeKey), hasBackup });
  });

  /** The sealed key backup, used to restore keys on a new device. Only its owner can fetch it. */
  app.get('/me/keys/backup', async (c) => {
    const { userId } = c.get('auth');
    await ctx.limiter.enforce(`key-backup:${userId}`, 30, 3600, 'Too many restore attempts. Try again later.');
    const row = await db.one<{ version: number; kdf: string; iterations: number; salt: string; iv: string; ciphertext: string }>(
      'SELECT version, kdf, iterations, salt, iv, ciphertext FROM key_backups WHERE user_id = $1',
      [userId],
    );
    if (!row) throw notFound('No key backup exists for this account.');
    return c.json({ backup: { v: row.version, kdf: row.kdf, iterations: row.iterations, salt: row.salt, iv: row.iv, ciphertext: row.ciphertext } });
  });

  /**
   * Publish an identity key with its sealed backup. The first key is created during setup;
   * `replace: true` rotates (or resets) the key — contacts see a "security code changed" notice.
   */
  app.put('/me/keys', async (c) => {
    const { userId } = c.get('auth');
    const input = await body(c, z.object({ kid: z.string(), publicKey: z.string(), backup: backupSchema, replace: z.boolean().optional() }), 256 * 1024);
    verifyPublicKey(input.publicKey, input.kid);
    await ctx.limiter.enforce(`key-publish:${userId}`, 10, 86400, 'Too many key changes today. Try again tomorrow.');

    const result = await db.tx(async (client) => {
      await client.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [userId]);
      const cur = (await client.query<{ kid: string }>('SELECT kid FROM user_keys WHERE user_id = $1 AND superseded_at IS NULL', [userId])).rows[0];
      const taken = await client.query('SELECT 1 FROM user_keys WHERE user_id = $1 AND kid = $2 AND superseded_at IS NOT NULL', [userId, input.kid]);
      if (taken.rowCount) throw new ApiError(409, 'key_reused', 'This key was used before. Generate a new one.');
      const systemMessages: { conversationId: string; messageId: string }[] = [];
      if (cur && cur.kid !== input.kid) {
        if (!input.replace) throw new ApiError(409, 'key_exists', 'This account already has an encryption key. Restore it with your recovery key, or reset it.');
        await client.query('UPDATE user_keys SET superseded_at = now() WHERE user_id = $1 AND superseded_at IS NULL', [userId]);
        // Every conversation partner learns that this person's security code changed.
        const convs = await client.query<{ conversation_id: string }>(
          `SELECT p.conversation_id FROM conversation_participants p
           WHERE p.user_id = $1 AND EXISTS (SELECT 1 FROM conversation_participants o WHERE o.conversation_id = p.conversation_id AND o.user_id <> $1)`,
          [userId],
        );
        for (const row of convs.rows) {
          const id = await insertSystemMessage(client, row.conversation_id, { type: 'key_changed', userId });
          systemMessages.push({ conversationId: row.conversation_id, messageId: id });
        }
      }
      if (!cur || cur.kid !== input.kid) {
        await client.query('INSERT INTO user_keys (user_id, kid, public_key) VALUES ($1, $2, $3)', [userId, input.kid, input.publicKey]);
      }
      await upsertBackup(client, userId, input.backup);
      return { systemMessages, changed: !!cur && cur.kid !== input.kid };
    });

    for (const m of result.systemMessages) await broadcastMessage(ctx, m.conversationId, m.messageId, 'message:new');
    if (result.changed) for (const id of await contactIds(ctx, userId)) ctx.hub.emitToUser(id, 'user:keys', { userId, kid: input.kid });
    return c.json({ me: await buildMe(ctx, userId) });
  });

  /** Re-seal the backup (e.g. with a new recovery key). The active key must not change here. */
  app.put('/me/keys/backup', async (c) => {
    const { userId } = c.get('auth');
    const { backup } = await body(c, z.object({ backup: backupSchema }), 256 * 1024);
    const active = await db.one('SELECT 1 FROM user_keys WHERE user_id = $1 AND superseded_at IS NULL', [userId]);
    if (!active) throw new ApiError(409, 'no_key', 'Set up encryption first.');
    await ctx.limiter.enforce(`key-backup-put:${userId}`, 20, 86400);
    await upsertBackup(db, userId, backup);
    return c.json({ me: await buildMe(ctx, userId) });
  });

  /** Anyone's public keys (current and previous), needed to encrypt to them and to read older messages. */
  app.get('/users/:id/keys', async (c) => {
    const id = zUuid.parse(c.req.param('id'));
    const exists = await db.one('SELECT 1 FROM users WHERE id = $1', [id]);
    if (!exists) throw notFound('User not found.');
    const r = await db.query<KeyRow>('SELECT kid, public_key, created_at, superseded_at FROM user_keys WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100', [id]);
    return c.json({ keys: r.rows.map(serializeKey) });
  });

  return app;
}

async function upsertBackup(db: { query: (sql: string, p: unknown[]) => Promise<unknown> }, userId: string, b: KeyBackup) {
  await db.query(
    `INSERT INTO key_backups (user_id, version, kdf, iterations, salt, iv, ciphertext) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (user_id) DO UPDATE SET version = EXCLUDED.version, kdf = EXCLUDED.kdf, iterations = EXCLUDED.iterations,
       salt = EXCLUDED.salt, iv = EXCLUDED.iv, ciphertext = EXCLUDED.ciphertext, updated_at = now()`,
    [userId, b.v, b.kdf, b.iterations, b.salt, b.iv, b.ciphertext],
  );
}
