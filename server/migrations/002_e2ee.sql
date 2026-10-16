-- End-to-end encryption (format "c1", see docs/E2EE.md).
-- The server stores public identity keys and an encrypted key backup it cannot open.
-- Message text and request notes become opaque envelopes: "c1.<senderKid>.<recipientKid>.<iv>.<ciphertext>".

-- Identity public keys. Old keys are kept (superseded) so earlier messages stay decryptable.
CREATE TABLE user_keys (
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kid           text NOT NULL,              -- base64url(SHA-256(public key)[0..16]), verified by the server
  public_key    text NOT NULL,              -- base64url of the uncompressed P-256 point (65 bytes)
  created_at    timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz,
  PRIMARY KEY (user_id, kid),
  CONSTRAINT user_keys_kid_shape CHECK (kid ~ '^[A-Za-z0-9_-]{22}$'),
  CONSTRAINT user_keys_public_shape CHECK (public_key ~ '^[A-Za-z0-9_-]{87}$')
);
CREATE UNIQUE INDEX user_keys_one_active ON user_keys (user_id) WHERE superseded_at IS NULL;

-- Private keys sealed with a key derived from the user's recovery key (never sent to the server).
CREATE TABLE key_backups (
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  version    smallint NOT NULL,
  kdf        text NOT NULL,
  iterations integer NOT NULL,
  salt       text NOT NULL,
  iv         text NOT NULL,
  ciphertext text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT key_backup_version CHECK (version = 1 AND kdf = 'pbkdf2-sha256'),
  CONSTRAINT key_backup_iterations CHECK (iterations BETWEEN 100000 AND 10000000),
  CONSTRAINT key_backup_size CHECK (char_length(ciphertext) <= 200000 AND char_length(salt) <= 64 AND char_length(iv) <= 32)
);

-- Server-side message search is impossible over ciphertext; search happens on the device.
DROP INDEX IF EXISTS messages_body_trgm_idx;

-- Envelopes are longer than the plaintext they carry (4,096 characters of text ≈ 22 KB envelope).
ALTER TABLE messages DROP CONSTRAINT message_body_len;
ALTER TABLE messages ADD CONSTRAINT message_body_len CHECK (char_length(body) <= 24000);
ALTER TABLE messages ADD CONSTRAINT message_body_envelope CHECK (body = '' OR kind = 'system' OR body ~ '^c1\.');

ALTER TABLE conversation_requests DROP CONSTRAINT request_note_len;
ALTER TABLE conversation_requests ADD CONSTRAINT request_note_len CHECK (char_length(note) <= 2400);
ALTER TABLE conversation_requests ADD CONSTRAINT request_note_envelope CHECK (note = '' OR note ~ '^c1\.');

-- Reports carry the text the reporter's own device decrypted (moderators cannot decrypt anything).
ALTER TABLE reports ADD COLUMN message_envelope text;
