import fs from 'node:fs/promises';
import { Readable } from 'node:stream';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppContext, HonoEnv } from '../context';
import { randomToken, sha256 } from '../lib/crypto';
import { ApiError, badRequest, notFound } from '../lib/errors';
import { query, zUuid } from '../lib/http';
import { log } from '../lib/log';
import { cleanFileName } from '../lib/text';
import { broadcastMessage } from '../messages/service';
import { acceptsProtectedMedia, blockState, requireParticipant } from '../users/access';
import { UnsupportedFileError } from './detect';
import { purgeIfExhausted } from './lifecycle';
import { MediaTooLargeError, type MediaProcessor } from './process';
import { receiveToTemp } from './receive';
import { keys } from './storage';

interface AccessRow {
  id: string;
  kind: string;
  mime: string;
  file_name: string;
  size_bytes: string;
  storage_key: string;
  thumb_key: string | null;
  view_policy: 'normal' | 'once' | 'twice';
  purged_at: Date | null;
  expired: boolean;
  message_id: string;
  conversation_id: string;
  sender_id: string;
  view_limit: number | null;
  views_used: number;
}

function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | 'invalid' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid';
  let start: number;
  let end: number;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return 'invalid';
  return { start, end };
}

const contentDisposition = (type: 'inline' | 'attachment', name?: string) => {
  if (!name) return type;
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
};

export function mediaRoutes(ctx: AppContext, media: MediaProcessor) {
  const app = new Hono<HonoEnv>();
  const { db, cfg, storage } = ctx;

  /** Everything required to read an attachment, or 404 — identical for "missing" and "not yours". */
  async function access(userId: string, attachmentId: string): Promise<AccessRow> {
    const r = await db.query<AccessRow>(
      `SELECT a.id, a.kind, a.mime, a.file_name, a.size_bytes::text, a.storage_key, a.thumb_key, a.view_policy, a.purged_at,
              (a.expires_at IS NOT NULL AND a.expires_at <= now()) AS expired,
              m.id::text AS message_id, m.conversation_id, m.sender_id, g.view_limit, g.views_used
       FROM attachments a
       JOIN messages m ON m.id = a.message_id
       JOIN conversation_participants vp ON vp.conversation_id = a.conversation_id AND vp.user_id = $2
       JOIN media_access_grants g ON g.attachment_id = a.id AND g.user_id = $2
       WHERE a.id = $1 AND m.deleted_at IS NULL AND m.id > vp.cleared_before_message_id
         AND (m.expires_at IS NULL OR m.expires_at > now())
         AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.user_id = $2 AND h.message_id = m.id)`,
      [attachmentId, userId],
    );
    const row = r.rows[0];
    if (!row) throw notFound('This media is not available.');
    return row;
  }

  async function stream(c: Context, key: string, size: number, headers: Record<string, string>, onComplete?: () => void, onStart?: () => Promise<void>) {
    const range = parseRange(c.req.header('range'), size);
    if (range === 'invalid') {
      return c.body(null, 416, { 'Content-Range': `bytes */${size}` });
    }
    const stat = await storage.stat(key);
    if (!stat) throw new ApiError(410, 'media_unavailable', 'This media is no longer available.');
    if (onStart) await onStart();
    const r = range ?? { start: 0, end: size - 1 };
    const node = storage.read(key, r);
    if (onComplete && r.end === size - 1) node.once('end', onComplete);
    node.once('error', (err) => log.warn('media stream error', { err: (err as Error).message }));
    const h: Record<string, string> = {
      ...headers,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(r.end - r.start + 1),
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cross-Origin-Resource-Policy': 'same-origin',
    };
    if (range) h['Content-Range'] = `bytes ${r.start}-${r.end}/${size}`;
    return new Response(Readable.toWeb(node) as unknown as ReadableStream, { status: range ? 206 : 200, headers: h });
  }

  // ---- upload ----
  app.post('/uploads', async (c) => {
    const { userId } = c.get('auth');
    const q = query(
      c,
      z.object({
        conversationId: zUuid,
        name: z.string().max(512).optional(),
        policy: z.enum(['normal', 'once', 'twice']).default('normal'),
        voice: z.enum(['0', '1']).default('0'),
      }),
    );
    const part = await requireParticipant(db, q.conversationId, userId);
    if (!part.peer_id) throw new ApiError(403, 'forbidden', 'This conversation is no longer available.');
    const b = await blockState(db, userId, part.peer_id);
    if (b.aBlockedB) throw new ApiError(403, 'you_blocked', 'Unblock this contact to send media.');
    if (b.bBlockedA) throw new ApiError(403, 'cannot_deliver', "This file couldn't be delivered.");
    const protectedMedia = q.policy !== 'normal';
    if (protectedMedia && !(await acceptsProtectedMedia(db, q.conversationId, part.peer_id))) {
      throw new ApiError(403, 'protected_media_not_allowed', "This person doesn't accept view-once media.");
    }
    await ctx.limiter.enforce(`upload:${userId}`, 60, 600, "You're uploading too quickly. Try again in a few minutes.");

    const voice = q.voice === '1';
    const name = cleanFileName(q.name, voice ? 'Voice message' : 'file');
    const received = await receiveToTemp(c.req.raw, storage, media.maxUploadBytes);
    let processedPath: string | null = null;
    try {
      const processed = await media
        .process({ path: received.path, size: received.size, sha256: received.sha256, name, voice, protectedMedia })
        .catch((err) => {
          if (err instanceof UnsupportedFileError) throw new ApiError(415, 'unsupported_file', err.message);
          if (err instanceof MediaTooLargeError) throw new ApiError(413, 'file_too_large', err.message);
          throw err;
        });
      processedPath = processed.path;
      if (protectedMedia && processed.kind === 'file') throw badRequest('Only photos, videos and audio can be sent as view once.', 'protected_kind');
      const storageKey = keys.media();
      await storage.putFile(storageKey, processed.path);
      processedPath = null;
      let thumbKey: string | null = null;
      if (processed.thumbnail && !protectedMedia) {
        thumbKey = keys.thumb();
        await storage.putBuffer(thumbKey, processed.thumbnail);
      }
      const fileName = processed.kind === 'voice' ? 'Voice message.mp3' : name;
      const row = await db.one<{ id: string }>(
        `INSERT INTO attachments (uploader_id, conversation_id, kind, mime, file_name, size_bytes, sha256, width, height, duration_ms, storage_key, thumb_key, view_policy)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
        [userId, q.conversationId, processed.kind, processed.mime, fileName, processed.size, processed.sha256, processed.width, processed.height, processed.durationMs, storageKey, thumbKey, q.policy],
      );
      return c.json(
        {
          attachment: {
            id: row!.id,
            kind: processed.kind,
            mime: processed.mime,
            label: processed.label,
            fileName,
            size: processed.size,
            width: processed.width,
            height: processed.height,
            durationMs: processed.durationMs,
            viewPolicy: q.policy,
            hasThumbnail: !!thumbKey,
          },
        },
        201,
      );
    } finally {
      await fs.rm(received.path, { force: true });
      if (processedPath && processedPath !== received.path) await fs.rm(processedPath, { force: true });
    }
  });

  // ---- normal media ----
  app.get('/attachments/:id/content', async (c) => {
    const { userId } = c.get('auth');
    const a = await access(userId, zUuid.parse(c.req.param('id')));
    if (a.view_policy !== 'normal') throw new ApiError(403, 'protected_media', 'Open this media from the conversation.');
    if (a.purged_at) throw new ApiError(410, 'media_unavailable', 'This media is no longer available.');
    const download = c.req.query('download') === '1' || a.kind === 'file';
    return stream(c, a.storage_key, Number(a.size_bytes), {
      'Content-Type': a.mime,
      'Content-Disposition': contentDisposition(download ? 'attachment' : 'inline', a.file_name),
      'Cache-Control': 'private, max-age=600',
      ETag: `"${a.id}"`,
    });
  });

  app.get('/attachments/:id/thumbnail', async (c) => {
    const { userId } = c.get('auth');
    const a = await access(userId, zUuid.parse(c.req.param('id')));
    if (a.view_policy !== 'normal' || !a.thumb_key) throw notFound('No preview.');
    const data = await storage.readBuffer(a.thumb_key).catch(() => null);
    if (!data) throw notFound('No preview.');
    return c.body(new Uint8Array(data), 200, {
      'Content-Type': 'image/webp',
      'Content-Length': String(data.length),
      'Cache-Control': 'private, max-age=3600',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    });
  });

  // ---- view once / view twice ----
  /**
   * Open a protected attachment. The view is counted here, atomically: the grant row is locked and
   * the increment is conditional, and a CHECK constraint makes over-counting impossible, so parallel
   * requests, extra tabs or replays cannot exceed the allowance.
   */
  app.post('/attachments/:id/views', async (c) => {
    const { userId, sessionId } = c.get('auth');
    const attachmentId = zUuid.parse(c.req.param('id'));
    await ctx.limiter.enforce(`view-start:${userId}`, 30, 60);
    const result = await db.tx(async (client) => {
      const r = await client.query<AccessRow>(
        `SELECT a.id, a.kind, a.mime, a.size_bytes::text, a.view_policy, a.purged_at,
                (a.expires_at IS NOT NULL AND a.expires_at <= now()) AS expired,
                m.id::text AS message_id, m.conversation_id, m.sender_id, g.view_limit, g.views_used
         FROM attachments a
         JOIN messages m ON m.id = a.message_id
         JOIN conversation_participants vp ON vp.conversation_id = a.conversation_id AND vp.user_id = $2
         JOIN media_access_grants g ON g.attachment_id = a.id AND g.user_id = $2
         WHERE a.id = $1 AND m.deleted_at IS NULL AND m.id > vp.cleared_before_message_id
           AND (m.expires_at IS NULL OR m.expires_at > now())
           AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.user_id = $2 AND h.message_id = m.id)
         FOR UPDATE OF g`,
        [attachmentId, userId],
      );
      const a = r.rows[0];
      if (!a) throw notFound('This media is not available.');
      if (a.view_policy === 'normal' || a.view_limit === null) throw badRequest('This media is not view-once.', 'not_protected');
      if (a.views_used >= a.view_limit) throw new ApiError(410, 'views_exhausted', 'You have already opened this.');
      if (a.purged_at || a.expired) throw new ApiError(410, 'media_expired', 'This media has expired.');
      const inc = await client.query<{ views_used: number }>(
        `UPDATE media_access_grants SET views_used = views_used + 1, first_viewed_at = COALESCE(first_viewed_at, now()), last_viewed_at = now()
         WHERE attachment_id = $1 AND user_id = $2 AND views_used < view_limit RETURNING views_used`,
        [attachmentId, userId],
      );
      if (!inc.rows[0]) throw new ApiError(410, 'views_exhausted', 'You have already opened this.');
      const size = Number(a.size_bytes);
      // Long enough to fetch the file on a slow connection (~100 KB/s), bounded to one hour.
      const ttl = Math.min(3600, Math.max(cfg.VIEW_SESSION_SECONDS, Math.ceil(size / 100_000)));
      const token = randomToken(32);
      const s = await client.query<{ expires_at: Date }>(
        `INSERT INTO media_view_sessions (token_hash, attachment_id, user_id, auth_session_id, expires_at)
         VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5)) RETURNING expires_at`,
        [sha256(token), attachmentId, userId, sessionId, ttl],
      );
      return { a, token, viewsUsed: inc.rows[0].views_used, expiresAt: s.rows[0]!.expires_at };
    });
    await broadcastMessage(ctx, result.a.conversation_id, result.a.message_id, 'message:updated');
    return c.json({
      token: result.token,
      expiresAt: result.expiresAt.toISOString(),
      viewsUsed: result.viewsUsed,
      viewLimit: result.a.view_limit,
      viewsRemaining: Math.max(0, (result.a.view_limit ?? 0) - result.viewsUsed),
      kind: result.a.kind,
      mime: result.a.mime,
      size: Number(result.a.size_bytes),
    });
  });

  /**
   * Bytes of a protected attachment for an open viewing session. The token is single-session:
   * bound to this user and this login, valid for a short window, usable (with Range resumption)
   * until the content has been delivered once, then dead.
   */
  app.get('/attachments/:id/protected', async (c) => {
    const { userId, sessionId } = c.get('auth');
    const attachmentId = zUuid.parse(c.req.param('id'));
    const token = c.req.header('x-view-token') ?? '';
    if (token.length < 32 || token.length > 64) throw new ApiError(403, 'invalid_view_token', 'This viewing session is not valid.');
    const vs = await db.one<{ id: string; storage_key: string; mime: string; size_bytes: string; purged: boolean }>(
      `SELECT s.id, a.storage_key, a.mime, a.size_bytes::text, a.purged_at IS NOT NULL AS purged
       FROM media_view_sessions s JOIN attachments a ON a.id = s.attachment_id
       WHERE s.token_hash = $1 AND s.attachment_id = $2 AND s.user_id = $3 AND s.auth_session_id = $4
         AND s.expires_at > now() AND s.completed_at IS NULL AND s.refunded_at IS NULL`,
      [sha256(token), attachmentId, userId, sessionId],
    );
    if (!vs) throw new ApiError(410, 'view_session_ended', 'This viewing session has ended.');
    if (vs.purged) throw new ApiError(410, 'media_expired', 'This media has expired.');
    return stream(
      c,
      vs.storage_key,
      Number(vs.size_bytes),
      {
        'Content-Type': vs.mime,
        'Content-Disposition': 'inline',
        'Cache-Control': 'no-store, max-age=0',
        Pragma: 'no-cache',
      },
      () => {
        void db
          .query('UPDATE media_view_sessions SET completed_at = now() WHERE id = $1 AND completed_at IS NULL', [vs.id])
          .then(() => purgeIfExhausted(ctx, attachmentId))
          .catch((err) => log.warn('view completion failed', { err }));
      },
      async () => {
        await db.query('UPDATE media_view_sessions SET content_started_at = COALESCE(content_started_at, now()) WHERE id = $1', [vs.id]);
      },
    );
  });

  return app;
}
