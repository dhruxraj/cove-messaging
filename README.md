# Cove — private messaging for the web

Cove is a WhatsApp-style messaging web app. You sign in with a Gmail address and a one-time code. Message text is end-to-end encrypted in the browser, and photos, videos and voice notes can be sent as **view once** or **view twice**, with the limit enforced by the server.

It is a complete application: a TypeScript API server (Hono on Node.js), PostgreSQL, WebSockets for real-time events, private media storage, and a responsive React client. It ships with Docker, a Caddy HTTPS configuration, and automated tests that drive real browsers with two or three independent accounts.

| | |
|---|---|
| ![Desktop conversation](docs/screenshots/desktop-chat.png) | ![Phone conversation](docs/screenshots/mobile-chat.png) |
| ![View-once viewer with watermark](docs/screenshots/view-once.png) | ![Recovery key](docs/screenshots/recovery-key.png) |

**Documentation**

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): components, data model, real-time protocol, media pipeline
- [docs/E2EE.md](docs/E2EE.md): the end-to-end encryption design and its limits
- [docs/SECURITY.md](docs/SECURITY.md): security review covering what is protected and what cannot be prevented
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md): production deployment, email setup, backups and operations

---

## Quick start (local development)

Requirements: **Node.js 22.12+**, **PostgreSQL 14+**, **ffmpeg/ffprobe** on the PATH.

```bash
npm install
cp .env.example .env                                # the defaults work locally
docker compose -f docker-compose.dev.yml up -d      # or use any local Postgres (see below)
npm run dev                                         # → http://localhost:8080
```

`npm run dev` rebuilds the web client on change, runs the API with reload, and starts a **development mailbox**. Sign-in codes are printed in the terminal (`mail │ Your Cove verification code is 123456`) instead of being emailed. Database migrations run automatically.

If you use your own Postgres, create the databases and set `DATABASE_URL` in `.env`:

```sql
CREATE DATABASE cove_dev; CREATE DATABASE cove_test; CREATE DATABASE cove_e2e;
```

To try two accounts at once, use two browser profiles (or a normal and a private window). Each needs its own Gmail-style address. In development the mailbox accepts any `@gmail.com` address, so nothing is actually sent.

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Web build (watch) + API server (reload) + dev mailbox |
| `npm run build` | Production build: `web/dist` (static client) and `server/dist` (bundled server) |
| `npm start` | Start the built server (`server/dist/index.js`) |
| `npm run migrate` | Apply database migrations explicitly (the server also does this at start-up) |
| `npm test` | Server test suite: 79 tests against a real Postgres, SMTP sink and ffmpeg |
| `npm run test:e2e` | Browser suite: 15 Playwright tests, two or three accounts each |
| `npm run typecheck` | TypeScript checks for server, web and e2e |
| `npm run secrets:generate` | Random `SESSION_SECRET` and `OTP_PEPPER` |
| `npm run vapid:generate` | Key pair for Web Push notifications (optional) |

Tests expect Postgres at `postgres://postgres:devpassword@127.0.0.1:5432` with the `cove_test` and `cove_e2e` databases (override with `TEST_DATABASE_URL` / `E2E_DATABASE_URL`). Browser tests need Chromium: `npx playwright install chromium`.

### Configuration

Everything is configured with environment variables. `.env.example` documents each one. The server validates them at start-up and **refuses to start in production** with development secrets, a non-HTTPS origin, or no SMTP server. Important settings:

| Variable | Default | Meaning |
|---|---|---|
| `APP_ORIGIN` | `http://localhost:8080` | Public URL; the only origin allowed to make API writes and WebSocket connections |
| `ALLOWED_EMAIL_DOMAINS` | `gmail.com` | Comma-separated list of accepted email domains |
| `SESSION_POLICY` | `single` | `single`: one active session per account; `multiple`: several |
| `OTP_TTL_SECONDS` / `OTP_MAX_ATTEMPTS` | `300` / `5` | Code lifetime and wrong guesses allowed per code |
| `MESSAGE_EDIT_WINDOW_MINUTES` | `15` | How long a message can be edited |
| `MAX_*_MB` | 8–64 | Upload limits per media type |
| `PROTECTED_MEDIA_TTL_DAYS` | `14` | Unopened view-once media is deleted after this |
| `VAPID_*` | — | Enables Web Push for closed tabs |

---

## Project layout

```
server/            API + WebSocket server (TypeScript, Hono, pg)
  migrations/      SQL migrations (schema, constraints, triggers)
  src/auth/        email codes, sessions, account deletion
  src/e2ee/        public keys, key backup, envelope checks
  src/messages/    sending, receipts, edits, reactions, forwarding
  src/media/       upload validation, processing (sharp/ffmpeg), storage, view-once
  src/realtime/    WebSocket hub (presence, typing, delivery acks)
  src/jobs/        cleanup: expired media and messages, refunds, storage GC
  test/            server tests + helpers (SMTP sink, fixtures, encrypted test client)
web/               React client (TypeScript, esbuild, plain CSS design system)
  src/lib/e2ee.ts  WebCrypto encryption primitives (also used by the server tests)
  src/state/       app store, outbox, sync, device key management
  src/components/  screens and UI
e2e/               Playwright tests (real server + browsers)
deploy/            Caddyfile, backup script, dev DB init
```

---

## Implemented features

**Accounts and sign-in**
- Registration and passwordless sign-in with a 6-digit code emailed over SMTP. Only `@gmail.com` addresses are accepted by default; Gmail dot and `+tag` variants count as the same mailbox.
- Codes expire after 5 minutes and work once. Only the newest code is valid. Five wrong guesses lock a code. Request cooldowns and hourly limits apply per address and per network. Codes are stored as HMAC hashes and never logged or returned by the API.
- One active session per account (configurable). A new sign-in ends the previous session immediately, over the WebSocket, and the owner gets an email and an in-app security notice.
- Sessions use HttpOnly, SameSite=Strict, `__Host-` cookies over HTTPS. They have absolute and idle expiry, CSRF tokens and origin checks. You can sign out, end individual sessions, or sign out everywhere.
- Account deletion requires a fresh emailed code.

**Profiles and privacy**
- Profile with photo (upload, preview, crop and reposition, replace, remove), display name, unique username, about/status, member-since date, online status and last seen.
- Privacy settings: who sees your photo, online status and last seen (everyone / contacts / nobody); read receipts; who can start conversations (everyone / requests / nobody); automatic media download; default disappearing-message timer; whether you accept view-once media (also per chat).
- Email addresses are never shown or searchable. People are found by username only.

**Conversations**
- Find people by username, message requests with an optional encrypted note, and accept or decline (the sender is never told about a decline).
- Search chats, people, and messages already decrypted on the device; in-chat search decrypts the full history locally.
- Archive, mute and delete a chat (for yourself only); block and unblock; report a user or message.

**Messaging**
- Real-time one-to-one messaging over WebSockets with an HTTP outbox: sends are idempotent, retried with backoff, held while offline, and resynced after reconnecting.
- Sent / delivered / read receipts (read receipts are reciprocal), failed state with retry, typing and online indicators, unread counts and date separators.
- Replies, forwarding, copying text, emoji picker and reactions, editing within a time window, deleting for me or for everyone, and disappearing messages (24 hours, 7 days or 90 days).
- Infinite scroll through history, and jumping to a search result or quoted message.

**End-to-end encryption** ([details](docs/E2EE.md))
- Message text, captions and request notes are encrypted in the browser (ECDH P-256 → HKDF → AES-256-GCM). The server stores and relays only ciphertext and rejects plaintext.
- Private keys are stored as non-extractable WebCrypto keys in IndexedDB. A 120-bit **recovery key** unlocks the server-held encrypted key backup on a new device.
- Safety numbers for verifying a contact, a warning on the device when a verified contact's key changes, a "security code changed" notice in chats, key rotation, and replacing the recovery key.

**Media**
- Photos, videos, voice messages recorded in the browser, audio files, and documents (PDF, Word, Excel, PowerPoint, OpenDocument, text, CSV, JSON, ZIP).
- Previews before sending, upload progress, retry, thumbnails, in-chat players with playback progress, and full-screen viewer.
- Server-side validation by content (not by name or browser MIME type). Images are re-encoded and audio/video re-muxed, which strips EXIF, GPS and container metadata.
- **View once / view twice** for photos, videos and voice/audio: counted atomically on the server, bound to the viewer's session with short-lived single-use tokens, never thumbnailed, deleted once the allowance is used or after 14 days unopened. The sender sees "Opened" / "Expired".
- Screenshot deterrence: protected media is drawn on a canvas (no image URL to save), right-click, drag and selection are blocked, the content is hidden when the window loses focus, it is watermarked with the viewer's username and time, and it is never cached.

**Notifications**
- In-app banners (never containing message text), sound, unread counts in the tab title, and request and security notices.
- Optional browser notifications: Web Push with a service worker when VAPID keys are configured, otherwise while a tab is open. They show "New message", or the sender's name if you allow it, and never the content.

**Interface**
- Responsive two-panel desktop layout and a single-column phone layout that keeps the composer above the on-screen keyboard. Light and dark themes (automatic or manual) and accessible labels and focus handling.

---

## Not included, and known limitations

Read [docs/SECURITY.md](docs/SECURITY.md#what-cove-cannot-prevent) for the full list. In short:

- **Media is not end-to-end encrypted.** Photos, videos, voice notes and files are encrypted in transit (HTTPS) and kept in private, access-checked storage, but the server can read them. This lets it validate files and strip location metadata, as the specification required. Message text *is* end-to-end encrypted.
- **No forward secrecy.** Encryption uses long-term identity keys with no ratchet (unlike Signal). If a device's private key is compromised, it can decrypt past messages that used that key. Key rotation limits this going forward.
- **The web client is served by the same server it protects against.** A compromised server could ship modified JavaScript. Safety numbers detect key substitution but not code substitution. Native apps or verifiable builds would be needed for stronger guarantees.
- **Screenshots cannot be blocked in a browser.** The deterrents above make copying harder, but anyone can photograph a screen. Reliable blocking needs a native Android app with `FLAG_SECURE` (see SECURITY.md).
- **One device at a time** (by design of the single-session policy). Signing out removes the keys from that device, so you need the recovery key to sign back in. A lost recovery key while signed out means old messages can no longer be read.
- **Not built:** group chats, voice and video calls, message scheduling, link previews, multi-device sync, an admin or moderation console (reports are stored in the database), media encryption at rest inside the app (use an encrypted disk or volume), and an S3 storage driver (the storage interface is ready for one).
- **Single server instance.** Real-time fan-out is in memory. Running several replicas needs a shared pub/sub such as Postgres `LISTEN/NOTIFY` or Redis (see ARCHITECTURE.md).
- **Web Push delivery** is implemented but could only be tested up to subscription in this environment. Delivery depends on the browser vendors' push services.
- **Browser codec support:** voice notes are converted to MP3, which plays everywhere. Uploaded H.264/AAC video plays in Chrome, Edge, Safari and Firefox, but not in Chromium builds that lack proprietary codecs.
