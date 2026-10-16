-- Cove initial schema.
-- Conventions: uuid primary keys for externally referenced entities, bigint identity for
-- high-volume ordered rows (messages, notifications). Every timestamp is timestamptz.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------
-- Users and profiles
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email            text NOT NULL,             -- address as entered (lower-cased), used for sending
  email_canonical  text NOT NULL,             -- mailbox identity (gmail dots / +tags removed)
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz,
  CONSTRAINT users_email_canonical_key UNIQUE (email_canonical),
  CONSTRAINT users_email_shape CHECK (email ~ '^[^@\s]+@[^@\s]+$' AND char_length(email) <= 254)
);

CREATE TABLE user_profiles (
  user_id            uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  username           text,
  display_name       text,
  bio                text NOT NULL DEFAULT '',
  avatar_key         text,                    -- storage key prefix; variants are <key>_512.webp / <key>_128.webp
  avatar_version     integer NOT NULL DEFAULT 0,
  setup_completed_at timestamptz,
  username_changed_at timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT username_shape CHECK (
    username IS NULL OR (username ~ '^[a-z0-9][a-z0-9_.]{1,22}[a-z0-9]$' AND username NOT LIKE '%..%')
  ),
  CONSTRAINT display_name_len CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 64),
  CONSTRAINT bio_len CHECK (char_length(bio) <= 160),
  CONSTRAINT setup_requires_identity CHECK (setup_completed_at IS NULL OR (username IS NOT NULL AND display_name IS NOT NULL))
);
CREATE UNIQUE INDEX user_profiles_username_key ON user_profiles (username);
CREATE INDEX user_profiles_username_prefix_idx ON user_profiles (username text_pattern_ops);

CREATE TYPE audience AS ENUM ('everyone', 'contacts', 'nobody');
CREATE TYPE message_permission AS ENUM ('everyone', 'requests', 'nobody');

CREATE TABLE user_privacy_settings (
  user_id                     uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  profile_photo               audience NOT NULL DEFAULT 'everyone',
  online_status               audience NOT NULL DEFAULT 'contacts',
  last_seen                   audience NOT NULL DEFAULT 'contacts',
  read_receipts               boolean NOT NULL DEFAULT true,
  who_can_message             message_permission NOT NULL DEFAULT 'requests',
  auto_download_media         boolean NOT NULL DEFAULT true,
  default_message_ttl_seconds integer,
  allow_protected_media       boolean NOT NULL DEFAULT true,
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT default_ttl_values CHECK (default_message_ttl_seconds IS NULL OR default_message_ttl_seconds IN (86400, 604800, 7776000))
);

CREATE TABLE user_notification_settings (
  user_id           uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  in_app_messages   boolean NOT NULL DEFAULT true,
  push_enabled      boolean NOT NULL DEFAULT false,
  push_show_preview boolean NOT NULL DEFAULT false,
  sound             boolean NOT NULL DEFAULT true,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Authentication
-- ---------------------------------------------------------------------------
CREATE TYPE otp_purpose AS ENUM ('register', 'login', 'delete_account');

CREATE TABLE auth_challenges (
  id              uuid PRIMARY KEY,
  purpose         otp_purpose NOT NULL,
  email           text NOT NULL,
  email_canonical text NOT NULL,
  user_id         uuid REFERENCES users(id) ON DELETE CASCADE,
  code_hash       bytea NOT NULL,             -- HMAC-SHA256(pepper, id || ':' || code); never the code itself
  attempts        integer NOT NULL DEFAULT 0,
  max_attempts    integer NOT NULL,
  deliverable     boolean NOT NULL,           -- false when no code was sent (sign-in for an unknown address)
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  consumed_at     timestamptz,
  request_ip      inet,
  CONSTRAINT attempts_within_max CHECK (attempts >= 0 AND attempts <= max_attempts)
);
CREATE INDEX auth_challenges_email_idx ON auth_challenges (email_canonical, created_at DESC);

CREATE TABLE sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash     bytea NOT NULL,              -- SHA-256 of the cookie token
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_active_at timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  ip             inet,
  user_agent     text,
  revoked_at     timestamptz,
  revoked_reason text,
  CONSTRAINT sessions_token_hash_key UNIQUE (token_hash),
  CONSTRAINT revoked_reason_values CHECK (
    revoked_reason IS NULL OR revoked_reason IN ('logout', 'replaced', 'logout_all', 'revoked', 'account_deleted')
  ),
  CONSTRAINT revoked_consistency CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);
CREATE INDEX sessions_user_active_idx ON sessions (user_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- Contacts: conversations, requests, blocks, reports
-- ---------------------------------------------------------------------------
CREATE TABLE conversations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                text NOT NULL DEFAULT 'direct',
  direct_key          text,                   -- "<smaller uuid>:<larger uuid>" ensures one chat per pair
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_message_at     timestamptz,
  message_ttl_seconds integer,
  CONSTRAINT conversations_kind CHECK (kind = 'direct'),
  CONSTRAINT conversations_direct_key UNIQUE (direct_key),
  CONSTRAINT conversation_ttl_values CHECK (message_ttl_seconds IS NULL OR message_ttl_seconds IN (86400, 604800, 7776000))
);

CREATE TABLE conversation_participants (
  conversation_id           uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id                   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at                 timestamptz NOT NULL DEFAULT now(),
  last_read_message_id      bigint NOT NULL DEFAULT 0,
  cleared_before_message_id bigint NOT NULL DEFAULT 0,  -- "delete chat": history up to here is gone for this user
  archived_at               timestamptz,
  hidden_at                 timestamptz,                -- removed from the list until a new message arrives
  muted                     boolean NOT NULL DEFAULT false,
  allow_protected_media     boolean,                    -- NULL = use the user's privacy default
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX conversation_participants_user_idx ON conversation_participants (user_id);

CREATE TYPE request_status AS ENUM ('pending', 'accepted', 'rejected', 'cancelled');

CREATE TABLE conversation_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note            text NOT NULL DEFAULT '',
  status          request_status NOT NULL DEFAULT 'pending',
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  responded_at    timestamptz,
  CONSTRAINT request_not_self CHECK (requester_id <> recipient_id),
  CONSTRAINT request_note_len CHECK (char_length(note) <= 280)
);
-- At most one open (pending or silently rejected) request per direction.
CREATE UNIQUE INDEX conversation_requests_open_key ON conversation_requests (requester_id, recipient_id)
  WHERE status IN ('pending', 'rejected');
CREATE INDEX conversation_requests_recipient_idx ON conversation_requests (recipient_id, status, created_at DESC);

CREATE TABLE blocks (
  blocker_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CONSTRAINT block_not_self CHECK (blocker_id <> blocked_id)
);
CREATE INDEX blocks_blocked_idx ON blocks (blocked_id);

-- ---------------------------------------------------------------------------
-- Messages
-- ---------------------------------------------------------------------------
CREATE TYPE message_kind AS ENUM ('text', 'image', 'video', 'audio', 'voice', 'file', 'system');

CREATE TABLE messages (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       uuid REFERENCES users(id) ON DELETE CASCADE,
  client_id       uuid,                         -- sender-generated idempotency key
  kind            message_kind NOT NULL,
  body            text NOT NULL DEFAULT '',
  reply_to_id     bigint REFERENCES messages(id) ON DELETE SET NULL,
  forwarded       boolean NOT NULL DEFAULT false,
  system_event    jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  edited_at       timestamptz,
  deleted_at      timestamptz,                  -- deleted for everyone (tombstone)
  delivered_at    timestamptz,
  read_at         timestamptz,
  expires_at      timestamptz,                  -- disappearing messages
  CONSTRAINT message_body_len CHECK (char_length(body) <= 4096),
  CONSTRAINT message_system_shape CHECK ((kind = 'system') = (sender_id IS NULL)),
  CONSTRAINT messages_sender_client_key UNIQUE (sender_id, client_id)
);
CREATE INDEX messages_conversation_idx ON messages (conversation_id, id DESC);
CREATE INDEX messages_body_trgm_idx ON messages USING gin (body gin_trgm_ops) WHERE deleted_at IS NULL AND kind <> 'system';
CREATE INDEX messages_expires_idx ON messages (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX messages_undelivered_idx ON messages (conversation_id) WHERE delivered_at IS NULL AND sender_id IS NOT NULL;

CREATE TABLE message_hidden (                   -- "delete for me"
  message_id bigint NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hidden_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, message_id)
);

CREATE TABLE message_reactions (
  message_id bigint NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id),
  CONSTRAINT reaction_emoji_len CHECK (char_length(emoji) BETWEEN 1 AND 16)
);

-- ---------------------------------------------------------------------------
-- Media
-- ---------------------------------------------------------------------------
CREATE TYPE attachment_kind AS ENUM ('image', 'video', 'audio', 'voice', 'file');
CREATE TYPE view_policy AS ENUM ('normal', 'once', 'twice');

CREATE TABLE attachments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  uploader_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id      bigint REFERENCES messages(id) ON DELETE CASCADE,
  kind            attachment_kind NOT NULL,
  mime            text NOT NULL,
  file_name       text NOT NULL,
  size_bytes      bigint NOT NULL,
  sha256          bytea NOT NULL,
  width           integer,
  height          integer,
  duration_ms     integer,
  storage_key     text NOT NULL,
  thumb_key       text,
  view_policy     view_policy NOT NULL DEFAULT 'normal',
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz,                  -- protected media is removed even if never opened
  purged_at       timestamptz,                  -- original bytes deleted from storage
  CONSTRAINT attachments_message_key UNIQUE (message_id),
  CONSTRAINT attachment_size_positive CHECK (size_bytes > 0),
  CONSTRAINT protected_media_kinds CHECK (view_policy = 'normal' OR kind IN ('image', 'video', 'audio', 'voice')),
  CONSTRAINT protected_media_no_thumb CHECK (view_policy = 'normal' OR thumb_key IS NULL)
);
CREATE INDEX attachments_unlinked_idx ON attachments (created_at) WHERE message_id IS NULL;
CREATE INDEX attachments_protected_live_idx ON attachments (expires_at) WHERE view_policy <> 'normal' AND purged_at IS NULL;

-- Who may load which attachment, and how many times.
CREATE TABLE media_access_grants (
  attachment_id   uuid NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  view_limit      smallint,                     -- NULL = unlimited (normal media)
  views_used      smallint NOT NULL DEFAULT 0,
  first_viewed_at timestamptz,
  last_viewed_at  timestamptz,
  PRIMARY KEY (attachment_id, user_id),
  CONSTRAINT view_limit_positive CHECK (view_limit IS NULL OR view_limit > 0),
  -- The database itself refuses to record more views than allowed.
  CONSTRAINT views_within_limit CHECK (views_used >= 0 AND (view_limit IS NULL OR views_used <= view_limit))
);
CREATE INDEX media_access_grants_user_idx ON media_access_grants (user_id);

CREATE TABLE media_view_sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash         bytea NOT NULL,
  attachment_id      uuid NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  auth_session_id    uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  content_started_at timestamptz,
  completed_at       timestamptz,
  refunded_at        timestamptz,
  CONSTRAINT media_view_sessions_token_key UNIQUE (token_hash)
);
CREATE INDEX media_view_sessions_open_idx ON media_view_sessions (expires_at) WHERE completed_at IS NULL AND refunded_at IS NULL;
CREATE INDEX media_view_sessions_attachment_idx ON media_view_sessions (attachment_id);

-- Storage objects waiting to be deleted (filled by triggers so row deletes can never leak files).
CREATE TABLE storage_gc (
  key         text PRIMARY KEY,
  enqueued_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Notifications, push, reports, rate limits
-- ---------------------------------------------------------------------------
CREATE TABLE notifications (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       text NOT NULL,
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at    timestamptz
);
CREATE INDEX notifications_user_idx ON notifications (user_id, id DESC);

CREATE TABLE push_subscriptions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  endpoint   text NOT NULL,
  p256dh     text NOT NULL,
  auth       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT push_subscriptions_endpoint_key UNIQUE (endpoint)
);
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions (user_id);

CREATE TYPE report_reason AS ENUM ('spam', 'harassment', 'inappropriate', 'impersonation', 'other');

CREATE TABLE reports (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  reported_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  conversation_id  uuid REFERENCES conversations(id) ON DELETE SET NULL,
  message_id       bigint REFERENCES messages(id) ON DELETE SET NULL,
  message_excerpt  text,                        -- copy shared by the reporter for moderation
  reason           report_reason NOT NULL,
  details          text NOT NULL DEFAULT '',
  status           text NOT NULL DEFAULT 'open',
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT report_details_len CHECK (char_length(details) <= 1000),
  CONSTRAINT report_status_values CHECK (status IN ('open', 'reviewing', 'actioned', 'dismissed'))
);
CREATE INDEX reports_status_idx ON reports (status, created_at);

CREATE UNLOGGED TABLE rate_limits (
  key          text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  count        integer NOT NULL
);

-- ---------------------------------------------------------------------------
-- Database-level guards
-- ---------------------------------------------------------------------------

-- Messages may only be written by participants of the conversation.
CREATE FUNCTION guard_message_sender() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.sender_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM conversation_participants
    WHERE conversation_id = NEW.conversation_id AND user_id = NEW.sender_id
  ) THEN
    RAISE EXCEPTION 'sender % is not a participant of conversation %', NEW.sender_id, NEW.conversation_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER messages_guard_sender BEFORE INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION guard_message_sender();

-- An attachment can only be linked to a message in the same conversation, sent by its uploader.
CREATE FUNCTION guard_attachment_link() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m RECORD;
BEGIN
  IF NEW.message_id IS NOT NULL AND (OLD.message_id IS DISTINCT FROM NEW.message_id) THEN
    IF OLD.message_id IS NOT NULL THEN
      RAISE EXCEPTION 'attachment already linked' USING ERRCODE = 'insufficient_privilege';
    END IF;
    SELECT conversation_id, sender_id INTO m FROM messages WHERE id = NEW.message_id;
    IF m.conversation_id IS DISTINCT FROM NEW.conversation_id OR m.sender_id IS DISTINCT FROM NEW.uploader_id THEN
      RAISE EXCEPTION 'attachment/message mismatch' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER attachments_guard_link BEFORE UPDATE OF message_id ON attachments
  FOR EACH ROW EXECUTE FUNCTION guard_attachment_link();

-- Media grants may only be issued to participants of the attachment's conversation.
CREATE FUNCTION guard_media_grant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM attachments a
    JOIN conversation_participants p ON p.conversation_id = a.conversation_id AND p.user_id = NEW.user_id
    WHERE a.id = NEW.attachment_id
  ) THEN
    RAISE EXCEPTION 'grantee is not a participant' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER media_access_grants_guard BEFORE INSERT ON media_access_grants
  FOR EACH ROW EXECUTE FUNCTION guard_media_grant();

-- Queue storage objects for deletion whenever their owning rows disappear or are replaced.
CREATE FUNCTION gc_attachment_storage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO storage_gc (key) VALUES (OLD.storage_key) ON CONFLICT DO NOTHING;
  IF OLD.thumb_key IS NOT NULL THEN
    INSERT INTO storage_gc (key) VALUES (OLD.thumb_key) ON CONFLICT DO NOTHING;
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER attachments_gc AFTER DELETE ON attachments
  FOR EACH ROW EXECUTE FUNCTION gc_attachment_storage();

CREATE FUNCTION gc_avatar_storage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.avatar_key IS NOT NULL AND (TG_OP = 'DELETE' OR OLD.avatar_key IS DISTINCT FROM NEW.avatar_key) THEN
    INSERT INTO storage_gc (key) VALUES (OLD.avatar_key || '_512.webp'), (OLD.avatar_key || '_128.webp')
      ON CONFLICT DO NOTHING;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER user_profiles_avatar_gc AFTER UPDATE OF avatar_key OR DELETE ON user_profiles
  FOR EACH ROW EXECUTE FUNCTION gc_avatar_storage();
