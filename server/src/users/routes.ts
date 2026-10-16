import fs from 'node:fs/promises';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext, HonoEnv } from '../context';
import { ApiError, badRequest, isUniqueViolation, notFound } from '../lib/errors';
import { body, query, zMessageId, zUuid } from '../lib/http';
import { cleanMultiline, cleanSingleLine, escapeLike } from '../lib/text';
import { detectFile, UnsupportedFileError } from '../media/detect';
import type { MediaProcessor } from '../media/process';
import { receiveToTemp } from '../media/receive';
import { keys } from '../media/storage';
import { audienceAllows, contactIds } from './access';
import { buildMe } from './me';
import { loadProfiles, publicProfiles } from './profiles';

const RESERVED = new Set(['admin', 'administrator', 'support', 'help', 'security', 'system', 'root', 'cove', 'official', 'moderator', 'staff', 'null', 'undefined', 'me']);
const USERNAME_RE = /^[a-z0-9][a-z0-9_.]{1,22}[a-z0-9]$/;

export function usernameProblem(u: string): string | null {
  if (u.length < 3 || u.length > 24) return 'Usernames must be 3–24 characters.';
  if (!USERNAME_RE.test(u) || u.includes('..')) return 'Use lowercase letters, numbers, dots and underscores. Start and end with a letter or number.';
  if (RESERVED.has(u)) return 'This username is reserved.';
  return null;
}

const audience = z.enum(['everyone', 'contacts', 'nobody']);
const ttl = z.union([z.literal(86400), z.literal(604800), z.literal(7776000), z.null()]);

export function userRoutes(ctx: AppContext, media: MediaProcessor) {
  const app = new Hono<HonoEnv>();
  const { db, cfg } = ctx;

  const broadcastProfileChange = async (userId: string) => {
    for (const id of await contactIds(ctx, userId)) ctx.hub.emitToUser(id, 'user:updated', { userId });
    ctx.hub.emitToUser(userId, 'me:updated', {});
  };

  app.get('/me', async (c) => c.json({ me: await buildMe(ctx, c.get('auth').userId) }));

  app.patch('/me/profile', async (c) => {
    const { userId } = c.get('auth');
    const input = await body(
      c,
      z.object({
        username: z.string().max(40).optional(),
        displayName: z.string().max(200).optional(),
        bio: z.string().max(1000).optional(),
      }),
    );
    const sets: string[] = [];
    const params: unknown[] = [userId];
    if (input.username !== undefined) {
      const u = input.username.trim().replace(/^@/, '').toLowerCase();
      const problem = usernameProblem(u);
      if (problem) throw badRequest(problem, 'invalid_username');
      const current = await db.one<{ username: string | null }>('SELECT username FROM user_profiles WHERE user_id = $1', [userId]);
      if (current?.username !== u) {
        await ctx.limiter.enforce(`username-change:${userId}`, 5, 86400, 'You can change your username up to 5 times a day.');
        params.push(u);
        sets.push(`username = $${params.length}`, 'username_changed_at = now()');
      }
    }
    if (input.displayName !== undefined) {
      const d = cleanSingleLine(input.displayName);
      if (d.length < 1 || d.length > 64) throw badRequest('Display names must be 1–64 characters.', 'invalid_display_name');
      params.push(d);
      sets.push(`display_name = $${params.length}`);
    }
    if (input.bio !== undefined) {
      const b = cleanMultiline(input.bio).replace(/\n+/g, ' ');
      if (b.length > 160) throw badRequest('Your status can be at most 160 characters.', 'invalid_bio');
      params.push(b);
      sets.push(`bio = $${params.length}`);
    }
    if (sets.length) {
      try {
        await db.tx(async (client) => {
          await client.query(`UPDATE user_profiles SET ${sets.join(', ')}, updated_at = now() WHERE user_id = $1`, params);
          // Profile setup is complete once both a username and a display name exist.
          await client.query(
            `UPDATE user_profiles SET setup_completed_at = now()
             WHERE user_id = $1 AND setup_completed_at IS NULL AND username IS NOT NULL AND display_name IS NOT NULL`,
            [userId],
          );
        });
      } catch (err) {
        if (isUniqueViolation(err, 'user_profiles_username_key')) throw new ApiError(409, 'username_taken', 'That username is already taken.');
        throw err;
      }
      await broadcastProfileChange(userId);
    }
    return c.json({ me: await buildMe(ctx, userId) });
  });

  app.get('/usernames/check', async (c) => {
    const { userId } = c.get('auth');
    await ctx.limiter.enforce(`username-check:${userId}`, 60, 60);
    const u = (c.req.query('u') ?? '').trim().replace(/^@/, '').toLowerCase();
    const problem = usernameProblem(u);
    if (problem) return c.json({ available: false, reason: problem });
    const taken = await db.one('SELECT 1 FROM user_profiles WHERE username = $1 AND user_id <> $2', [u, userId]);
    return c.json({ available: !taken, reason: taken ? 'That username is already taken.' : null });
  });

  // ---- avatar ----
  app.post('/me/avatar', async (c) => {
    const { userId } = c.get('auth');
    await ctx.limiter.enforce(`avatar:${userId}`, 20, 3600, 'Too many photo changes. Try again later.');
    const q = query(c, z.object({ x: z.coerce.number().min(0).optional(), y: z.coerce.number().min(0).optional(), size: z.coerce.number().min(1).optional() }));
    const file = await receiveToTemp(c.req.raw, ctx.storage, cfg.MAX_AVATAR_MB * 1024 * 1024);
    try {
      const detected = await detectFile(file.path, file.size, 'avatar').catch(() => null);
      if (!detected || detected.family !== 'image') throw badRequest('Choose a JPEG, PNG, WebP or GIF image.', 'unsupported_file');
      const crop = q.x !== undefined && q.y !== undefined && q.size ? { x: q.x, y: q.y, size: q.size } : null;
      const { large, small } = await media.avatar(file.path, crop).catch((err) => {
        if (err instanceof UnsupportedFileError) throw badRequest(err.message, 'unsupported_file');
        throw err;
      });
      const prefix = keys.avatarPrefix();
      await ctx.storage.putBuffer(`${prefix}_512.webp`, large);
      await ctx.storage.putBuffer(`${prefix}_128.webp`, small);
      await db.query('UPDATE user_profiles SET avatar_key = $2, avatar_version = avatar_version + 1, updated_at = now() WHERE user_id = $1', [userId, prefix]);
    } finally {
      await fs.rm(file.path, { force: true });
    }
    await broadcastProfileChange(userId);
    return c.json({ me: await buildMe(ctx, userId) });
  });

  app.delete('/me/avatar', async (c) => {
    const { userId } = c.get('auth');
    await db.query('UPDATE user_profiles SET avatar_key = NULL, avatar_version = avatar_version + 1, updated_at = now() WHERE user_id = $1', [userId]);
    await broadcastProfileChange(userId);
    return c.json({ me: await buildMe(ctx, userId) });
  });

  app.get('/users/:id/avatar', async (c) => {
    const { userId } = c.get('auth');
    const id = zUuid.parse(c.req.param('id'));
    const size = c.req.query('size') === '512' ? 512 : 128;
    const row = (await loadProfiles(db, userId, [id])).get(id);
    const self = id === userId;
    const visible =
      row?.avatar_key && (self || (!row.blocked_me && !row.blocked_by_me && audienceAllows(row.profile_photo, { self, contact: row.is_contact })));
    if (!row || !visible) throw notFound('No photo.');
    const key = `${row.avatar_key}_${size}.webp`;
    const stat = await ctx.storage.stat(key);
    if (!stat) throw notFound('No photo.');
    const data = await ctx.storage.readBuffer(key);
    return c.body(new Uint8Array(data), 200, {
      'Content-Type': 'image/webp',
      'Content-Length': String(data.length),
      'Cache-Control': 'private, max-age=3600',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    });
  });

  // ---- settings ----
  app.patch('/me/privacy', async (c) => {
    const { userId } = c.get('auth');
    const input = await body(
      c,
      z
        .object({
          profilePhoto: audience,
          onlineStatus: audience,
          lastSeen: audience,
          readReceipts: z.boolean(),
          whoCanMessage: z.enum(['everyone', 'requests', 'nobody']),
          autoDownloadMedia: z.boolean(),
          defaultMessageTtlSeconds: ttl,
          allowProtectedMedia: z.boolean(),
        })
        .partial()
        .strict(),
    );
    const map: Record<string, string> = {
      profilePhoto: 'profile_photo',
      onlineStatus: 'online_status',
      lastSeen: 'last_seen',
      readReceipts: 'read_receipts',
      whoCanMessage: 'who_can_message',
      autoDownloadMedia: 'auto_download_media',
      defaultMessageTtlSeconds: 'default_message_ttl_seconds',
      allowProtectedMedia: 'allow_protected_media',
    };
    const entries = Object.entries(input).filter(([, v]) => v !== undefined);
    if (entries.length) {
      const sets = entries.map(([k], i) => `${map[k]} = $${i + 2}`);
      await db.query(`UPDATE user_privacy_settings SET ${sets.join(', ')}, updated_at = now() WHERE user_id = $1`, [userId, ...entries.map(([, v]) => v)]);
      await broadcastProfileChange(userId);
    }
    return c.json({ me: await buildMe(ctx, userId) });
  });

  app.patch('/me/notifications', async (c) => {
    const { userId } = c.get('auth');
    const input = await body(
      c,
      z.object({ inAppMessages: z.boolean(), pushEnabled: z.boolean(), pushShowPreview: z.boolean(), sound: z.boolean() }).partial().strict(),
    );
    const map: Record<string, string> = { inAppMessages: 'in_app_messages', pushEnabled: 'push_enabled', pushShowPreview: 'push_show_preview', sound: 'sound' };
    const entries = Object.entries(input).filter(([, v]) => v !== undefined);
    if (entries.length) {
      const sets = entries.map(([k], i) => `${map[k]} = $${i + 2}`);
      await db.query(`UPDATE user_notification_settings SET ${sets.join(', ')}, updated_at = now() WHERE user_id = $1`, [userId, ...entries.map(([, v]) => v)]);
    }
    return c.json({ me: await buildMe(ctx, userId) });
  });

  // ---- discovery ----
  app.get('/users/search', async (c) => {
    const { userId } = c.get('auth');
    await ctx.limiter.enforce(`user-search:${userId}`, 60, 60, 'Too many searches. Slow down a little.');
    const q = (c.req.query('q') ?? '').trim().replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9_.]{2,24}$/.test(q)) return c.json({ users: [] });
    const r = await db.query<{ user_id: string }>(
      `SELECT p.user_id FROM user_profiles p
       WHERE p.setup_completed_at IS NOT NULL AND p.user_id <> $1
         AND (p.username = $2 OR p.username LIKE $3 ESCAPE '\\')
         AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = p.user_id AND b.blocked_id = $1)
       ORDER BY (p.username = $2) DESC, char_length(p.username), p.username
       LIMIT 20`,
      [userId, q, escapeLike(q) + '%'],
    );
    const profiles = await publicProfiles(ctx, userId, r.rows.map((x) => x.user_id));
    return c.json({ users: r.rows.map((x) => profiles.get(x.user_id)) });
  });

  app.get('/users/:id', async (c) => {
    const { userId } = c.get('auth');
    const id = zUuid.parse(c.req.param('id'));
    const rows = await loadProfiles(db, userId, [id]);
    const row = rows.get(id);
    if (!row) throw notFound('User not found.');
    const profile = (await publicProfiles(ctx, userId, [id])).get(id)!;
    const conv = await db.one<{ id: string }>(
      `SELECT c.id FROM conversations c WHERE c.direct_key = $1`,
      [userId < id ? `${userId}:${id}` : `${id}:${userId}`],
    );
    return c.json({ user: profile, conversationId: conv?.id ?? null });
  });

  // ---- blocking ----
  app.get('/blocks', async (c) => {
    const { userId } = c.get('auth');
    const r = await db.query<{ blocked_id: string; created_at: Date }>('SELECT blocked_id, created_at FROM blocks WHERE blocker_id = $1 ORDER BY created_at DESC', [userId]);
    const profiles = await publicProfiles(ctx, userId, r.rows.map((x) => x.blocked_id));
    return c.json({ blocked: r.rows.map((x) => ({ user: profiles.get(x.blocked_id), blockedAt: x.created_at.toISOString() })) });
  });

  app.post('/users/:id/block', async (c) => {
    const { userId } = c.get('auth');
    const id = zUuid.parse(c.req.param('id'));
    if (id === userId) throw badRequest("You can't block yourself.");
    const exists = await db.one('SELECT 1 FROM users WHERE id = $1', [id]);
    if (!exists) throw notFound('User not found.');
    await db.tx(async (client) => {
      await client.query('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, id]);
      // Open requests in either direction are withdrawn.
      await client.query(
        `UPDATE conversation_requests SET status = 'cancelled', responded_at = now()
         WHERE status IN ('pending','rejected') AND ((requester_id = $1 AND recipient_id = $2) OR (requester_id = $2 AND recipient_id = $1))`,
        [userId, id],
      );
    });
    ctx.hub.emitToUser(userId, 'user:updated', { userId: id });
    return c.json({ ok: true });
  });

  app.delete('/users/:id/block', async (c) => {
    const { userId } = c.get('auth');
    const id = zUuid.parse(c.req.param('id'));
    await db.query('DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2', [userId, id]);
    ctx.hub.emitToUser(userId, 'user:updated', { userId: id });
    return c.json({ ok: true });
  });

  // ---- reports ----
  app.post('/reports', async (c) => {
    const { userId } = c.get('auth');
    const input = await body(
      c,
      z.object({
        userId: zUuid,
        messageId: zMessageId.optional(),
        reason: z.enum(['spam', 'harassment', 'inappropriate', 'impersonation', 'other']),
        details: z.string().max(1000).optional(),
        // Plaintext of the reported message, decrypted and shared voluntarily by the reporter's device.
        excerpt: z.string().max(4000).optional(),
        block: z.boolean().optional(),
      }),
    );
    if (input.userId === userId) throw badRequest("You can't report yourself.");
    await ctx.limiter.enforce(`report:${userId}`, 10, 86400, 'You have sent many reports today. Try again tomorrow.');
    const target = await db.one('SELECT 1 FROM users WHERE id = $1', [input.userId]);
    if (!target) throw notFound('User not found.');
    let excerpt: string | null = null;
    let envelope: string | null = null;
    let conversationId: string | null = null;
    if (input.messageId) {
      // Only messages the reporter can actually see, sent by the reported user.
      const m = await db.one<{ body: string; conversation_id: string; deleted_at: Date | null }>(
        `SELECT m.body, m.conversation_id, m.deleted_at FROM messages m
         JOIN conversation_participants p ON p.conversation_id = m.conversation_id AND p.user_id = $1
         WHERE m.id = $2 AND m.sender_id = $3`,
        [userId, input.messageId, input.userId],
      );
      if (!m) throw notFound('Message not found.');
      // The server cannot decrypt messages. The reporter's device supplies the text it decrypted;
      // the ciphertext is kept alongside it. Moderators should treat the excerpt as the reporter's claim.
      excerpt = !m.deleted_at && input.excerpt ? cleanMultiline(input.excerpt).slice(0, 4000) : null;
      envelope = m.deleted_at ? null : m.body || null;
      conversationId = m.conversation_id;
    }
    await db.query(
      `INSERT INTO reports (reporter_id, reported_user_id, conversation_id, message_id, message_excerpt, message_envelope, reason, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [userId, input.userId, conversationId, input.messageId ?? null, excerpt, envelope, input.reason, cleanMultiline(input.details ?? '')],
    );
    if (input.block) await db.query('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, input.userId]);
    return c.json({ ok: true });
  });

  return app;
}
