# Security review

This document describes what Cove protects against and how, which tests prove it, and what it cannot prevent. Each claim points to the code or test that implements it. The end-to-end encryption design has its own document: [E2EE.md](E2EE.md).

**Threat model.** We assume attackers who:

- know or guess usernames and email addresses;
- can send arbitrary HTTP and WebSocket requests;
- can upload hostile files;
- can host malicious websites that the user visits;
- can observe the network, which is protected by TLS;
- may obtain a copy of the database or storage volume (message text stays protected by E2EE);
- may be a curious server operator (message text is protected; media and metadata are not).

We do **not** defend against a compromised user device, a compromised browser, or an operator who serves malicious client code (see [limits](#what-cove-cannot-prevent)).

---

## Authentication (`server/src/auth`)

| Protection | How | Tested in |
|---|---|---|
| No passwords | 6-digit codes from a CSPRNG (`crypto.randomInt`), emailed over SMTP (TLS required in production) | `auth.test.ts` |
| Codes never stored in plaintext | `HMAC-SHA-256(OTP_PEPPER, challengeId + ":" + code)` compared in constant time. Codes never appear in API responses or logs, and the logger redacts `code`, `otp*`, `*token`, `cookie`, `email` keys defensively | "never stores the code in plaintext and never returns it" |
| Expiry and single use | 5-minute TTL. `consumed_at` is set inside the same transaction that verifies (row-locked). Requesting a new code invalidates older ones | "rejects an expired code", "rejects a reused code", "only the newest code…" |
| Brute force | 5 attempts per code (the counter is committed even on failure and capped by a CHECK constraint, so concurrent guesses can't exceed it). 15 failures per address per hour block new codes. 60 verifications per IP per 15 minutes | "locks a code after too many wrong attempts", "counts concurrent guesses correctly" |
| Request flooding | Per-address cooldown (60 s) and hourly cap (5), and per-IP cap (30/hour). Limits are stored in Postgres so they survive restarts and work across replicas | "rate-limits code requests…", "enforces a resend cooldown" |
| No account enumeration | `/auth/otp` returns the same response for registered and unknown addresses. The email itself tells the owner what happened. Sign-in for an unknown address creates an undeliverable challenge that can never verify | "does not reveal whether an address is registered…" |
| Gmail only, one account per mailbox | Domain allow-list (`ALLOWED_EMAIL_DOMAINS`). Canonicalisation removes Gmail dots and `+tags`. A `UNIQUE (email_canonical)` constraint prevents duplicates | "treats Gmail dot and +tag variants as the same mailbox" |
| A single mistyped code doesn't lock you out | The limit is per code (5 tries) and a new code can be requested at any time within the hourly limits | e2e "rejects … wrong codes with clear messages" |

## Sessions

- **Token:** 32 random bytes in an `HttpOnly; SameSite=Strict; Path=/` cookie. Over HTTPS it also uses `Secure` and the `__Host-` prefix, which pins it to the exact origin. The database stores only `SHA-256(token)`.
- **Expiry:** 30-day absolute and 14-day idle expiry, checked on every request. Open WebSockets are revalidated every 60 seconds.
- **Single active session** (`SESSION_POLICY=single`): creating a session revokes all others in the same transaction, serialised by a row lock on the user so two simultaneous sign-ins cannot both survive. The replaced session's WebSockets are closed with an explanation, its push subscriptions are deleted, and the owner receives an email and an in-app security notice (device and IP).
- **Sign-out:** sign out, end a specific session, and sign out everywhere. Sign-out sends `Clear-Site-Data: "cache", "storage"` and deletes the device's encryption keys.
- **Tests:** "uses an HttpOnly, SameSite=Strict cookie…", "allows one active session…", "expires sessions (absolute and idle)", e2e "a new sign-in ends the previous session…".

## Request forgery, XSS and response hardening (`server/src/lib/http.ts`)

- **CSRF, three layers:**
  1. Every state-changing request must carry an `Origin` equal to `APP_ORIGIN` (or `Sec-Fetch-Site: same-origin`).
  2. Authenticated writes also need the session-bound token `x-csrf-token = HMAC(SESSION_SECRET, "csrf:" + sessionToken)`.
  3. JSON bodies require `Content-Type: application/json`, which plain cross-site form posts cannot send.

  Tests: "rejects state-changing requests from another origin", "requires the session-bound CSRF token…", "requires a JSON content type".
- **WebSocket hijacking:** upgrades are accepted only from `APP_ORIGIN`, with a valid session cookie. Frames are capped at 16 KB and typing events are throttled. Test: "rejects WebSocket connections without a session or from another origin".
- **Content-Security-Policy:**

  ```
  default-src 'self'; script-src 'self'; style-src 'self';
  img-src 'self' blob: data:; media-src 'self' blob:;
  connect-src 'self' wss://<origin>; object-src 'none'; base-uri 'none';
  frame-ancestors 'none'; form-action 'self'
  ```

  There is no `unsafe-inline` or `unsafe-eval`. Other headers: `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, COOP and CORP `same-origin`, `Permissions-Policy` (camera off, microphone self only), HSTS on HTTPS, and `Cache-Control: no-store` for all API responses. Test: "sends strict security headers".
- **XSS:** message text is end-to-end encrypted, so the server cannot sanitise it. The client renders all user content as React text nodes, never as HTML. Links are created only for `http:`/`https:` URLs, with `rel="noopener noreferrer nofollow"`. Bidi-override and control characters are stripped before encrypting and again before display, to prevent spoofing. Tests: e2e "renders hostile text as plain text", server "carries message text only as opaque ciphertext…".
- **Uploaded files are served safely:** `Content-Security-Policy: default-src 'none'; sandbox`, `nosniff`, and `Content-Disposition` (documents always as attachments), so an uploaded HTML or SVG file can never run script on the app's origin.

## Authorization (`server/src/users/access.ts`, triggers in `migrations/001_initial.sql`)

- Every conversation, message, attachment and media request is resolved through a join on `conversation_participants` for the caller. "Doesn't exist" and "not yours" both return 404, so identifiers cannot be probed.
- **Database-level guards** (so a bug in a route cannot bypass them):
  - a trigger refuses messages from non-participants;
  - attachments can only be linked to a message in the same conversation, by their uploader, once;
  - media grants can only be issued to participants;
  - CHECK constraints keep view counts within their limit.
- Blocking: a blocked user cannot send messages, react, edit, upload, start a conversation or send a request, and does not see the blocker's photo, online status or last seen. Open requests in both directions are withdrawn.
- Email addresses and session details of other users are never serialised.
- Tests: "keeps conversations private to their participants", "prevents reading or changing another user's data by changing identifiers", "never exposes email addresses…", "blocking stops messages…".

## Uploads and media (`server/src/media`)

- **Streaming with limits:** bodies are streamed to a private temp file, the size limit is enforced while bytes arrive (an oversized `Content-Length` is refused before reading), and interrupted uploads leave nothing behind.
- **Validation by content:** a whitelist of magic bytes decides the type; the file name and browser MIME type are never trusted.
  - Images are fully decoded and **re-encoded** by sharp, with a pixel-count limit against decompression bombs. This drops EXIF/GPS data and any appended payload (polyglots).
  - Audio and video are parsed by ffprobe, checked against codec and duration whitelists, and remuxed or transcoded with all metadata removed (`-map_metadata -1`).
  - Office files are identified by reading the ZIP central directory only, so zip bombs are harmless.
  - Legacy OLE files are accepted only with a doc/xls/ppt extension. Text files must be valid UTF-8 without NUL bytes. Executables and anything else are refused.
- **ffmpeg** runs with server-built argument lists (user input never reaches them) and with timeouts and output caps.
- **Storage:** objects are stored under random, server-generated keys with no user data in paths, in a directory with mode 0700 that is never served statically. Deleting rows enqueues their objects for deletion via triggers, so files cannot be orphaned.
- **Caching:** normal media is cached privately for 10 minutes. View-once media is `no-store`.
- **Tests:** "stores photos privately, strips EXIF/GPS…", "re-encodes images so appended payloads (polyglots) are dropped", "rejects disallowed or disguised files by content, not by name", "enforces per-type size limits", "leaves nothing behind when an upload is interrupted", "removes files deleted for everyone from storage", "does not serve storage or source files over HTTP".

## View once / view twice (`server/src/media/routes.ts`, `lifecycle.ts`)

**How a view is counted.** Opening protected media is a `POST /attachments/:id/views` request. Inside a transaction, the viewer's grant row is locked and `views_used` is incremented only if it is below `view_limit`. A CHECK constraint makes over-counting impossible even if the code were wrong. The server then returns a **viewing token**: 32 random bytes stored hashed, bound to that user *and* that login session, and valid for 5 minutes (longer for big files, at most 1 hour). The bytes are fetched with that token. Once the content has been delivered completely, the token stops working.

**Rules for interrupted and failed views**

| Situation | Effect on the allowance |
|---|---|
| The open request fails, or the content download never starts before the token expires (closed tab, network failure, decoding never begins) | The view is **given back** by the cleanup job |
| The download starts but is interrupted | The view **counts**. The same token can resume with HTTP Range requests until it completes or expires, and the client retries automatically |
| The content was delivered | The token is dead. Refreshing, opening another tab, or replaying the request needs a new view |
| Several tabs or simultaneous requests | Each open consumes a view, and the limit can never be exceeded (row lock plus CHECK constraint) |
| The sender | Never has access to the media after sending |
| Forwarding | Refused for protected media |

**Deletion.** When every allowance is used and no viewing session is in flight, the original file is deleted and the message shows "Opened". Unopened protected media is deleted after `PROTECTED_MEDIA_TTL_DAYS` (default 14) and shows "Expired". No thumbnails are ever made for protected media. Recipients can turn off receiving protected media globally or per chat.

**Tests:** "allows exactly one view, then denies further access and deletes the original", "allows two views for view-twice…", "cannot be exceeded by simultaneous requests", "binds viewing tokens to the user and login session", "gives the view back if the media never started loading, but not after delivery began", "expires unopened view-once media", plus e2e "enforces view once and view twice on the server, across reloads".

## Screenshot deterrence and its limits

What the web client does for protected media:

- **Drawing:** images are drawn on a `<canvas>` from an in-memory blob. There is no image URL to save, open in a new tab or drag. Video and audio play from a revoked-on-close object URL with `controlsList="nodownload"`, and Picture-in-Picture and remote playback are disabled.
- **Interaction:** context menu, dragging, copying and text selection are disabled in the viewer.
- **Hiding:** the content is hidden while the window is not focused or the page is hidden, which defeats many screen-recording pickers, app switchers and some screenshot tools. It is also hidden briefly on Print Screen / ⌘⇧3–5, and the clipboard is cleared.
- **Watermark:** a repeating watermark shows the viewer's username and the time, which deters sharing and identifies its source.
- **Cleanup:** the canvas is wiped and object URLs are revoked when the viewer closes. Bytes are never cached (`no-store`), and printing is disabled by a print stylesheet.

**What this cannot do.** No web page can stop the operating system from taking a screenshot or recording the screen, or stop someone photographing the display with another device. A determined recipient can also read the decoded bytes from browser memory with developer tools. The app tells users this when they send and view protected media.

**If screenshot blocking is mandatory**, build native clients:

- **Android:** a native or Capacitor/WebView app can set `WindowManager.LayoutParams.FLAG_SECURE` on the viewer window. That blocks screenshots and screen recording on the vast majority of devices and blanks the window in the app switcher. A Trusted Web Activity cannot set this flag, so it has to be a WebView-based or native app. Cove's API and client code can be reused inside one.
- **iOS:** there is no supported way to block screenshots. Apps can detect them (`userDidTakeScreenshotNotification`) and detect recording or mirroring (`UIScreen.isCaptured`) in order to hide content and notify the sender.
- **Desktop:** Electron's `setContentProtection(true)` (Windows `WDA_EXCLUDEFROMCAPTURE`, macOS `NSWindowSharingNone`) excludes the window from most capture APIs.

## Rate limits (`server/src/lib/rate-limit.ts`, stored in Postgres)

| Action | Limit |
|---|---|
| Code requests | 1 per 60 s per address, 5/hour per address, 30/hour per IP; 15 failed verifications/hour per address block new codes (all configurable) |
| Code verification | 60 per 15 minutes per IP (configurable) |
| Messages | 30 per 10 s per user (clients back off automatically using `Retry-After`) |
| Uploads / forwards | 60 / 30 per 10 minutes |
| Reactions, user search, username checks | 60 per minute |
| Opening protected media | 30 per minute |
| New conversations / reports | 50 / 10 per day |
| Username changes / photo changes | 5 per day / 20 per hour |
| Key publish / backup fetch / backup re-seal | 10 per day / 30 per hour / 20 per day |
| Account deletion codes | 3 per hour |

## Data minimisation and privacy

- **Message text is end-to-end encrypted.** The server stores ciphertext only. Database dumps, backups and logs contain no message text.
- **Notifications:** push payloads never contain message content. In-app banners show only the sender's name and the kind of message.
- **Email addresses** are used only to sign in and for security emails. They are never shown to other users or used for discovery.
- **Reciprocal privacy:** hiding your last seen hides others' from you, and turning off read receipts disables them both ways. Declined requests are never revealed to the requester.
- **Deletion:** account deletion (confirmed with an emailed code) cascades to the profile, sessions, sent messages, uploads, grants, keys and the key backup. Media files are deleted by the storage queue. "Delete for everyone" removes the attachment and its file. When both participants delete a chat, the server deletes its history.
- **Logs** are JSON lines with request id, method, path and status, without query strings or bodies. Sensitive field names are redacted.
- **Push SSRF guard:** push endpoints are accepted only for known browser push services. Test: "only accepts push subscriptions for known push services (SSRF guard)".

## Secrets and configuration

- All secrets come from environment variables (`.env` is git-ignored; `.env.example` contains no real values).
- In production the server refuses to start with development secrets, identical `SESSION_SECRET` and `OTP_PEPPER`, a non-HTTPS `APP_ORIGIN`, or without SMTP, and it requires TLS for SMTP.
- The frontend bundle contains no secrets. The only configuration it receives is public: the VAPID public key and the allowed email domains.

---

## What Cove cannot prevent

1. **Screenshots, screen recordings and photos of the screen.** See above. Web deterrents can be bypassed, so treat view-once as "won't stay in the chat", not as "can't be copied".
2. **A malicious or compromised server operator** can read media files, see metadata (who talks to whom, when, how much, from which IP), serve modified JavaScript that steals keys or plaintext, or suppress messages. E2EE protects stored and relayed message text against database or backup leaks and passive operators. Safety numbers detect key substitution, not code substitution.
3. **No forward secrecy.** A stolen private key decrypts all past messages that used it (see E2EE.md).
4. **Compromise of the user's email.** An attacker with access to the inbox can sign in (which signs the real user out and emails them) and post as the user. They cannot read past messages without the recovery key, and if they reset the keys, contacts see "security code changed". Users should protect their Google account with 2-step verification.
5. **Compromised devices or browsers** (malware, malicious extensions) can read everything the user can.
6. **Lost recovery key while signed out.** Old messages become permanently unreadable. This is by design, because nobody can recover them.
7. **Abuse at scale.** Rate limits and blocking exist, but there is no spam classifier or moderator console. Reports are stored in the `reports` table for operators to review. Put the service behind a WAF or CDN with bot protection for public deployments.
8. **Denial of service.** Basic limits are in place, but volumetric attacks must be handled upstream (CDN or provider).
9. **Media at rest** is stored unencrypted by the application (under random names, in a private directory). Use an encrypted disk or volume, and encrypt backups.

## Recommended next steps

- Adopt a ratcheting protocol (libsignal) for forward secrecy, and extend E2EE to media by sending client-encrypted blobs with server-side validation replaced by client-side checks.
- Serve the web client from a separate static origin with Subresource Integrity and reproducible builds, or ship native apps (which also enables `FLAG_SECURE`).
- Add an S3-compatible storage driver with server-side encryption, multi-replica real-time fan-out (Postgres `LISTEN/NOTIFY`), and an admin console for reports.
- Add an external penetration test before a public launch.
