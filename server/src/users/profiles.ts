import type { AppContext } from '../context';
import type { Queryable } from '../db';
import { audienceAllows, type Audience } from './access';

export interface ProfileRow {
  id: string;
  created_at: Date;
  last_seen_at: Date | null;
  username: string | null;
  display_name: string | null;
  bio: string;
  avatar_key: string | null;
  avatar_version: number;
  profile_photo: Audience;
  online_status: Audience;
  last_seen: Audience;
  is_contact: boolean;
  blocked_by_me: boolean;
  blocked_me: boolean;
}

export interface PublicProfile {
  id: string;
  username: string | null;
  displayName: string;
  bio: string;
  avatarUrl: string | null;
  joinedAt: string;
  presence: { online: boolean | null; lastSeenAt: string | null };
  isContact: boolean;
  blockedByMe: boolean;
  deleted?: boolean;
}

/** Load profile rows for several users as seen by `viewerId`. */
export async function loadProfiles(db: Queryable, viewerId: string, ids: string[]): Promise<Map<string, ProfileRow>> {
  if (!ids.length) return new Map();
  const r = await db.query<ProfileRow>(
    `SELECT u.id, u.created_at, u.last_seen_at, p.username, p.display_name, p.bio, p.avatar_key, p.avatar_version,
            s.profile_photo, s.online_status, s.last_seen,
            EXISTS (SELECT 1 FROM conversation_participants a JOIN conversation_participants b ON b.conversation_id = a.conversation_id
                    WHERE a.user_id = $1 AND b.user_id = u.id AND a.user_id <> b.user_id) AS is_contact,
            EXISTS (SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = u.id) AS blocked_by_me,
            EXISTS (SELECT 1 FROM blocks WHERE blocker_id = u.id AND blocked_id = $1) AS blocked_me
     FROM users u
     JOIN user_profiles p ON p.user_id = u.id
     JOIN user_privacy_settings s ON s.user_id = u.id
     WHERE u.id = ANY($2::uuid[])`,
    [viewerId, ids],
  );
  return new Map(r.rows.map((row) => [row.id, row]));
}

export async function viewerLastSeenSetting(db: Queryable, viewerId: string): Promise<Audience> {
  const r = await db.query<{ last_seen: Audience }>('SELECT last_seen FROM user_privacy_settings WHERE user_id = $1', [viewerId]);
  return r.rows[0]?.last_seen ?? 'nobody';
}

export function serializeProfile(ctx: AppContext, viewerId: string, row: ProfileRow, viewerLastSeen: Audience): PublicProfile {
  const self = row.id === viewerId;
  const contact = row.is_contact;
  // When either side has blocked the other, only the name stays visible.
  const hidden = !self && (row.blocked_me || row.blocked_by_me);
  const photo = !hidden && !!row.avatar_key && audienceAllows(row.profile_photo, { self, contact });
  const online = !hidden && audienceAllows(row.online_status, { self, contact });
  // Last seen is reciprocal: if you hide yours, you can't see other people's.
  const lastSeen = !hidden && audienceAllows(row.last_seen, { self, contact }) && (self || viewerLastSeen !== 'nobody');
  const isOnline = ctx.hub.isOnline(row.id);
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name ?? row.username ?? 'Cove user',
    bio: hidden ? '' : row.bio,
    avatarUrl: photo ? `/api/users/${row.id}/avatar?v=${row.avatar_version}` : null,
    joinedAt: row.created_at.toISOString(),
    presence: {
      online: online ? isOnline : null,
      lastSeenAt: lastSeen && !isOnline && row.last_seen_at ? row.last_seen_at.toISOString() : null,
    },
    isContact: contact,
    blockedByMe: row.blocked_by_me,
  };
}

export const deletedProfile = (id: string): PublicProfile => ({
  id,
  username: null,
  displayName: 'Deleted account',
  bio: '',
  avatarUrl: null,
  joinedAt: new Date(0).toISOString(),
  presence: { online: null, lastSeenAt: null },
  isContact: false,
  blockedByMe: false,
  deleted: true,
});

export async function publicProfiles(ctx: AppContext, viewerId: string, ids: string[]): Promise<Map<string, PublicProfile>> {
  const unique = [...new Set(ids)];
  const [rows, viewerLastSeen] = await Promise.all([loadProfiles(ctx.db, viewerId, unique), viewerLastSeenSetting(ctx.db, viewerId)]);
  const out = new Map<string, PublicProfile>();
  for (const id of unique) {
    const row = rows.get(id);
    out.set(id, row ? serializeProfile(ctx, viewerId, row, viewerLastSeen) : deletedProfile(id));
  }
  return out;
}
