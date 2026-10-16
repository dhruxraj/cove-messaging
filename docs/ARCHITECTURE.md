# Architecture

```
 Browser (React SPA)                     Cove server (Node.js 22, one process)                 PostgreSQL
 ─────────────────────                   ──────────────────────────────────────                ──────────
 UI ─ app store ─ outbox ──HTTPS/JSON──▶ Hono routes ─ auth/CSRF/origin middleware ──────────▶ schema + triggers
       │            │                         │                                               rate limits
       │            └──raw upload (XHR)──▶ media pipeline: sniff → sharp / ffprobe+ffmpeg ──▶ attachments, grants
       │                                      │                    │
 WebCrypto E2EE ◀──────WebSocket /ws────── realtime hub            ▼
 IndexedDB keys        (events, acks,      (presence, typing,   private storage (disk, 0700,
                        typing, presence)   delivery acks)        random keys, never static)
                                              │
                                     cleanup job (advisory-locked): refunds, purge, expiry, GC
                                              │
                                     SMTP (codes, security email) · Web Push (VAPID, optional)
```

## Why these technologies

- **Hono + @hono/node-server** for the API: small, typed, standard `Request`/`Response`, and easy to stream uploads and ranged downloads.
- **PostgreSQL via `pg`** with hand-written SQL migrations. Consistency rules (view limits, participant checks, one chat per pair, unique usernames) live in constraints and triggers, so no code path can bypass them.
- **`ws`** for WebSockets, mounted on the same HTTP server and origin, so cookies and CSP stay simple.
- **sharp** (libvips) for images and **ffmpeg/ffprobe** for audio and video. Both are mature and fast, and re-encoding strips metadata.
- **React** with a small external store and **esbuild** for the client, plus a hand-written CSS design system with light and dark tokens. The same server serves the SPA, so there is one origin and no CORS.
- **Next.js was not used**: the app needs a long-lived WebSocket server and streaming uploads, which fit a plain Node server better than Next's serverless model. The npm registry was also unavailable while this was built, so only vetted, already-available packages were used.

## Server modules (`server/src`)

| Module | Responsibility |
|---|---|
| `config.ts` | Environment validation (zod) and production safety checks |
| `app.ts` | Wires middleware, routes, static client, WebSocket hub, cleanup job |
| `lib/http.ts` | Security headers, origin guard, session/CSRF auth, bounded JSON bodies, error mapping |
| `auth/` | Code challenges, verification, sessions, account deletion |
| `users/` | Profiles, privacy serialisation, discovery, avatars, blocking, reports |
| `conversations/` | Conversation list and summaries, requests, archive/mute/TTL, delete-for-me |
| `messages/` | Send (idempotent), deliver/read receipts, edit, delete, reactions, forward |
| `e2ee/` | Identity public keys, sealed key backups, envelope freshness checks |
| `media/` | Upload receive → detect → process → store; normal and protected delivery; purge/refund |
| `realtime/` | WebSocket hub (per-user fan-out, acks, heartbeats, session revalidation) and handlers (presence, typing) |
| `notifications/` | In-app notifications, Web Push |
| `jobs/cleanup.ts` | Periodic maintenance, one replica at a time via `pg_try_advisory_lock` |

## Data model (main tables)

| Table | Purpose / key constraints |
|---|---|
| `users`, `user_profiles` | Account, unique canonical email, unique username (format CHECK), profile fields |
| `user_privacy_settings`, `user_notification_settings` | Audiences, receipts, who can message, media download, default TTL, notification prefs |
| `auth_challenges` | Hashed codes, attempts ≤ max (CHECK), expiry, consumed flag |
| `sessions` | Token hash (unique), expiry, revocation reason |
| `conversations`, `conversation_participants` | One direct chat per pair (`direct_key` UNIQUE); per-user read position, cleared-history point, archive/mute, protected-media preference |
| `conversation_requests` | Pending/accepted/rejected/cancelled; one open request per direction (partial unique index); encrypted note |
| `messages` | `bigint` identity ids (ordering); `(sender_id, client_id)` UNIQUE for idempotency; encrypted `body` (CHECK: empty or `c1.` envelope); delivered/read/expiry timestamps |
| `message_hidden`, `message_reactions` | Delete-for-me; one reaction per user per message |
| `attachments` | Kind, validated MIME, size, dimensions, duration, storage keys, view policy, expiry/purge |
| `media_access_grants` | Who may view what, `views_used ≤ view_limit` (CHECK) |
| `media_view_sessions` | Hashed viewing tokens bound to user + login session; started/completed/refunded |
| `user_keys`, `key_backups` | Public identity keys (old keys kept), sealed private-key backup |
| `blocks`, `reports`, `notifications`, `push_subscriptions` | Safety and notifications |
| `storage_gc`, `rate_limits` | Deferred file deletion queue (filled by triggers); fixed-window counters |

Triggers enforce that only participants can author messages or receive media grants, that attachments are linked only to their uploader's message in the same conversation, and that deleted rows enqueue their files for deletion.

## Real-time protocol

- **Sending is HTTP; the WebSocket only pushes events.** Each send carries a client-generated UUID, so retries (after timeouts, reconnects or reloads) can never duplicate a message. The client keeps unsent messages in an outbox. It retries with exponential backoff, waits for the `online` event while offline, re-encrypts on `409 stale_key`, and shows "Failed" with Retry/Delete after repeated errors.
- **Server → client events:** `message:new` (acknowledged by the client, which marks it *delivered*), `message:updated`, `message:removed`, `message:status`, `conversation:updated/removed/read`, `typing`, `presence`, `request:new/updated`, `notification:new`, `user:updated/deleted`, `user:keys`, `me:updated`, `session:revoked`.
- **Client → server:** `ack`, `ping`, `visibility` (to decide whether to push), `typing`.
- **Reconnection:** exponential backoff with jitter and a heartbeat. After reconnecting, the client resyncs: it reloads the conversation list (which marks pending messages delivered) and fetches everything after the newest message it holds in each loaded conversation. Nothing is lost if events were missed.
- **Presence:** emitted to contacts on first connect and last disconnect, filtered by each person's privacy settings and blocks.

## Media pipeline

1. **Receive:** `POST /api/uploads?conversationId&policy&voice&name` with a raw body. It is streamed to a temp file with a size cap and SHA-256.
2. **Detect:** magic-byte whitelist; ZIP central-directory inspection for Office/ODF.
3. **Process:** images are re-encoded (≤4096 px) and get a 480 px WebP thumbnail unless protected. Video is remuxed to MP4/WebM, with a poster frame and duration. Voice notes and Ogg/WebM audio are transcoded to MP3 (universally playable); other audio is remuxed without metadata.
4. **Store:** the file goes under a random key and an `attachments` row is created, not yet linked to a message.
5. **Link:** the message send links the attachment (trigger-checked) and creates grants. Normal media gets grants for both participants; protected media gets a grant for the recipient only, with a view limit.
6. **Serve:**
   - Normal media: `GET /api/attachments/:id/content` (Range supported, private cache 10 min) and `/thumbnail`.
   - Protected media: `POST …/views` (counts the view, returns a token), then `GET …/protected` with `x-view-token` (`no-store`).
7. **Clean up:** unlinked uploads are deleted after 1 hour, exhausted or expired protected media is purged, disappearing messages are deleted, and the storage GC queue is drained. Abandoned view sessions are refunded.

## Client (`web/src`)

- `state/app.ts`: the store (conversations, message pages, pending outbox, presence, typing, requests, notifications), session lifecycle, sync, and event handling.
- `state/crypto.ts`: device keys (IndexedDB), setup, restore, rotation and reset, contact key cache, lazy memoised decryption (`usePlaintext`), and pins for verification.
- `components/`: `Auth`, `Setup` (profile and encryption), `Shell` (layout), `Rail` (list, search, requests, notifications), `Chat` (header, search, banners), `Timeline` (messages, menus, pagination), `Composer` (text, emoji, attachments, voice), `Media` (players and viewers), `Settings`, `ProfilePanel`, `dialogs`.
- Plaintext exists only in memory. Drafts are not persisted, and the service worker caches nothing.

## Scaling notes

- A single Node process comfortably serves thousands of concurrent WebSocket connections. The real-time hub keeps connections in memory, so **more than one replica needs a shared bus**: publish events through Postgres `LISTEN/NOTIFY` (or Redis pub/sub) and have each replica deliver to its own sockets. Delivery acks can then update the database directly.
- Rate limits, sessions, the cleanup lock and migrations are already safe with several replicas (they use Postgres).
- Media storage is behind a small `Storage` interface (`put/stat/read/delete/copy`). An S3/R2/GCS driver with server-side encryption can be added without touching the rest of the code.
