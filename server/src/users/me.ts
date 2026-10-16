import type { AppContext } from '../context';
import { notFound } from '../lib/errors';

export interface MeRow {
  id: string;
  email: string;
  created_at: Date;
  username: string | null;
  display_name: string | null;
  bio: string;
  avatar_key: string | null;
  avatar_version: number;
  setup_completed_at: Date | null;
  profile_photo: string;
  online_status: string;
  last_seen: string;
  read_receipts: boolean;
  who_can_message: string;
  auto_download_media: boolean;
  default_message_ttl_seconds: number | null;
  allow_protected_media: boolean;
  in_app_messages: boolean;
  push_enabled: boolean;
  push_show_preview: boolean;
  sound: boolean;
}

export async function buildMe(ctx: AppContext, userId: string) {
  const row = await ctx.db.one<MeRow>(
    `SELECT u.id, u.email, u.created_at, p.username, p.display_name, p.bio, p.avatar_key, p.avatar_version, p.setup_completed_at,
            s.profile_photo, s.online_status, s.last_seen, s.read_receipts, s.who_can_message, s.auto_download_media,
            s.default_message_ttl_seconds, s.allow_protected_media,
            n.in_app_messages, n.push_enabled, n.push_show_preview, n.sound
     FROM users u
     JOIN user_profiles p ON p.user_id = u.id
     JOIN user_privacy_settings s ON s.user_id = u.id
     JOIN user_notification_settings n ON n.user_id = u.id
     WHERE u.id = $1`,
    [userId],
  );
  if (!row) throw notFound('Account not found.');
  const key = await ctx.db.one<{ kid: string; created_at: Date; has_backup: boolean }>(
    `SELECT k.kid, k.created_at, EXISTS (SELECT 1 FROM key_backups b WHERE b.user_id = k.user_id) AS has_backup
     FROM user_keys k WHERE k.user_id = $1 AND k.superseded_at IS NULL`,
    [userId],
  );
  return {
    id: row.id,
    email: row.email,
    createdAt: row.created_at.toISOString(),
    username: row.username,
    displayName: row.display_name,
    bio: row.bio,
    avatarUrl: row.avatar_key ? `/api/users/${row.id}/avatar?v=${row.avatar_version}` : null,
    setupComplete: !!row.setup_completed_at,
    privacy: {
      profilePhoto: row.profile_photo,
      onlineStatus: row.online_status,
      lastSeen: row.last_seen,
      readReceipts: row.read_receipts,
      whoCanMessage: row.who_can_message,
      autoDownloadMedia: row.auto_download_media,
      defaultMessageTtlSeconds: row.default_message_ttl_seconds,
      allowProtectedMedia: row.allow_protected_media,
    },
    notifications: {
      inAppMessages: row.in_app_messages,
      pushEnabled: row.push_enabled,
      pushShowPreview: row.push_show_preview,
      sound: row.sound,
    },
    limits: {
      editWindowMinutes: ctx.cfg.MESSAGE_EDIT_WINDOW_MINUTES,
      deleteWindowMinutes: ctx.cfg.MESSAGE_DELETE_WINDOW_MINUTES,
      maxImageMb: ctx.cfg.MAX_IMAGE_MB,
      maxVideoMb: ctx.cfg.MAX_VIDEO_MB,
      maxAudioMb: ctx.cfg.MAX_AUDIO_MB,
      maxFileMb: ctx.cfg.MAX_FILE_MB,
      maxAvatarMb: ctx.cfg.MAX_AVATAR_MB,
      maxProtectedMb: ctx.cfg.MAX_PROTECTED_MB,
    },
    pushPublicKey: ctx.push.publicKey(),
    encryption: key ? { keyId: key.kid, createdAt: key.created_at.toISOString(), hasBackup: key.has_backup } : null,
  };
}

export type Me = Awaited<ReturnType<typeof buildMe>>;
