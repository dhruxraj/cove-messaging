# End-to-end encryption in Cove

**Goal:** only the two people in a conversation can read its messages. The Cove server stores and relays message text without being able to decrypt it.

**Scope of v1:** message text, media captions and message-request notes are end-to-end encrypted. Photos, videos, voice messages and files are **not**; see [What is not covered](#what-is-not-covered).

All cryptography uses the browser's built-in WebCrypto API (the same primitives also run in Node.js for the tests). No custom algorithm is involved. The code is in [`web/src/lib/e2ee.ts`](../web/src/lib/e2ee.ts) (primitives) and [`web/src/state/crypto.ts`](../web/src/state/crypto.ts) (key management). The server side is in [`server/src/e2ee/`](../server/src/e2ee).

## Keys

| Key | Algorithm | Where it lives |
|---|---|---|
| Identity key pair | ECDH on NIST P-256 | Private key: this device only, as a **non-extractable** `CryptoKey` in IndexedDB. Public key: server (`user_keys`) |
| Key id (`kid`) | First 16 bytes of SHA-256(raw public key), base64url | Public; the server recomputes and checks it |
| Pair key | HKDF-SHA-256 over the ECDH shared secret → AES-256-GCM | Derived on each device when needed; never stored or sent |
| Recovery key | 120 random bits as 24 Crockford base32 characters (`7KQM-2XPA-…`) | Shown once to the user. Never sent to the server |
| Backup key | PBKDF2-SHA-256 (210,000 iterations, 16-byte salt) of the recovery key → AES-256-GCM | Derived on the device; a non-extractable copy is kept on the device to re-seal the backup after a rotation |

Pair key derivation: `HKDF(salt = "cove-e2ee-c1", ikm = ECDH(myPrivate, theirPublic), info = "cove/c1/pair|" + sorted(kidA, kidB))`. Both people compute the same key.

## Message envelope (format `c1`)

```
c1.<senderKid>.<recipientKid>.<iv>.<ciphertext>          (all parts base64url)
```

- **Plaintext:** `{"v":1,"t":"<text>"}`, UTF-8, padded with spaces to a multiple of 64 bytes so the ciphertext length only reveals a coarse size bucket.
- **Cipher:** AES-256-GCM with a fresh random 96-bit IV per message.
- **Associated data:** `c1|<senderUserId>><recipientUserId>|<senderKid>><recipientKid>`. Decryption fails if the server swaps sender and recipient (for example, presenting Alice's message as Bob's) or relabels keys.

The server only checks the envelope's *shape* and that it names the **current** keys of both people. Anything else, including plaintext, is rejected (`400 not_encrypted`). The database also has a `CHECK` constraint so that user message bodies are either empty or envelopes. If a key changed in the meantime, the server answers `409 stale_key` with the current key ids. The client then fetches the new key, re-encrypts and retries automatically.

Edits are new envelopes. Forwarding decrypts on the sender's device and re-encrypts for each target conversation. A reply quote carries the quoted message's envelope, which the reader decrypts locally.

## Setup, restore, rotation, reset

1. **Setup** (after creating a profile): the browser generates the identity key pair and a recovery key, and shows the recovery key. The user must type its last four characters to confirm they saved it. The browser then uploads the public key and an **encrypted backup**: `AES-GCM(backupKey, {keys: [all private keys]})` with associated data bound to the user id. The server cannot open the backup.
2. **New device or after signing out:** the user signs in with an email code and is asked for the recovery key. The browser downloads the sealed backup (owner only, rate-limited), derives the backup key, decrypts, and imports every private key as non-extractable. A wrong recovery key fails AES-GCM authentication.
3. **Rotation** (Settings → Security): a new identity key is generated and appended to the keyring, the backup is re-sealed with the backup key kept on the device, and the new public key is published. Older keys stay in the backup, so earlier messages remain readable. Contacts see a "security code changed" notice.
4. **New recovery key** (Settings → Security): re-seals the same keyring under a new recovery key, for when the old one was lost but a device is still signed in. The old recovery key stops working.
5. **Reset** (when the recovery key is lost and no device is signed in): a fresh key replaces the old one. Messages encrypted to the old key can no longer be read on any device. Contacts see the security code change.

## Verification and key-change warnings

- **Safety number:** 60 digits derived from both users' ids and current public keys, in the same order on both sides. Comparing it in person or on a call confirms that nobody, including the server, substituted a key.
- Each device remembers ("pins") the key it last saw for each contact. If a contact's key changes **after you marked it verified**, the chat shows a warning. This comes from the device's own pin, not from the server, so a server that silently swaps keys cannot hide it.
- When a key is rotated or reset, the server also posts a "security code changed" system message in every conversation of that user.

## What is not covered

- **Media files are not end-to-end encrypted.** The specification asks the server to validate uploads by content, strip metadata, generate thumbnails and enforce view-once limits, and all of those require the server to read the file. Media is protected in transit (HTTPS), stored under random keys in private storage, and served only to participants after authorization checks. Encrypting the storage volume is recommended (see DEPLOYMENT.md).
- **Metadata** is visible to the server: who talks to whom and when, message sizes (padded), reactions, read receipts, profile data, IP addresses.
- **Notifications** never contain message text; the server cannot know it. They say "New message", or the sender's name if the user allows it.
- **Moderation:** when a user reports a message, their device decrypts it and, only if they agree, sends the text to moderators along with the ciphertext. The server cannot check that the reported text is genuine. A future version could add message franking for that.

## Known limitations of this design

- **No forward secrecy or post-compromise security.** Messages use long-term identity keys (static-static ECDH), not a ratcheting protocol such as Signal's Double Ratchet. Someone who obtains a private key and a copy of the ciphertext can decrypt every past message sent to or from that key. Moving to a vetted ratchet implementation (for example, libsignal) is the main upgrade path.
- **Key ids are checked against the *current* keys only.** A malicious server could replay an old ciphertext as a new message. The client does not yet detect duplicates or reordering (no transcript consistency).
- **Code delivery:** web E2EE depends on the JavaScript the server delivers. A compromised server could ship code that leaks keys or plaintext. Safety numbers do not detect this. Mitigations include serving from a separate, audited static origin with Subresource Integrity, reproducible builds, browser extensions that verify bundles, or native apps.
- **XSS:** non-extractable keys cannot be copied out by injected script, but injected script could still *use* them while the page is open. A strict Content-Security-Policy (no inline or eval script) and React's text-only rendering are the defenses.
- **Recovery key strength:** with 120 random bits, the backup cannot practically be brute-forced. However, anyone who obtains both the recovery key and the user's email inbox can restore the keys.
- **Single device:** with the default one-session policy, only one device holds keys at a time. Simply signing in elsewhere keeps the old device's keys in its storage (they are only usable with a valid session). Explicit sign-out and "sign out everywhere" delete them from devices that are online.
