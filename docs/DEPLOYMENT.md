# Deployment

Cove runs as one Node.js process (API + WebSocket + static client) next to PostgreSQL, with ffmpeg installed and a persistent volume for media. It needs **HTTPS** in production: the server refuses an `http://` origin, and browsers require a secure context for WebCrypto, the microphone and notifications.

## Option A — Docker Compose with automatic HTTPS (recommended)

Requirements: a Linux host with Docker, ports 80 and 443 open, and a DNS record (`chat.example.com`) pointing at the host.

```bash
git clone <your repo> cove && cd cove
cp .env.example .env
npm run secrets:generate          # or: openssl rand -base64 48 (twice)
```

Edit `.env`:

```ini
NODE_ENV=production
DOMAIN=chat.example.com
APP_ORIGIN=https://chat.example.com
POSTGRES_PASSWORD=<long random>
SESSION_SECRET=<random 1>
OTP_PEPPER=<random 2>
SMTP_HOST=… SMTP_PORT=… SMTP_USER=… SMTP_PASS=…   # see "Email" below
MAIL_FROM=Cove <no-reply@chat.example.com>
# optional: VAPID_* from `npm run vapid:generate` for push notifications
```

```bash
docker compose up -d --build
docker compose logs -f app        # "listening" when ready; migrations run automatically
```

The stack (`docker-compose.yml`):

- **caddy**: obtains and renews TLS certificates and proxies HTTP and WebSockets to the app (`deploy/Caddyfile`).
- **app**: the Cove image (`Dockerfile`: Node 22, ffmpeg, non-root user, health check). Media is stored in the `app-data` volume.
- **db**: PostgreSQL 16 on an internal-only network.
- **backup**: a nightly `pg_dump` plus a media archive into `./backups`, keeping 14 days.

Upgrades: `git pull && docker compose up -d --build`. Migrations are applied at start-up under an advisory lock.

## Option B — any Node host

1. Install Node.js 22.12+, PostgreSQL 14+, and `ffmpeg` (which includes `ffprobe`).
2. Build and install:

   ```bash
   npm ci && npm run build
   npm ci --omit=dev -w server
   ```

3. Set the environment (see `.env.example`), including `NODE_ENV=production`, `DATABASE_URL`, `STORAGE_DIR` (a persistent directory writable only by the service user), `WEB_DIST_DIR=/path/to/web/dist`, and `TRUST_PROXY=true` behind a reverse proxy.
4. Run `cd server && node dist/index.js` under systemd or another supervisor. `node dist/migrate.js` applies migrations explicitly if you set `RUN_MIGRATIONS=false`.
5. Put a TLS-terminating reverse proxy in front (Caddy, nginx or a cloud load balancer). It must forward WebSocket upgrades on `/ws` and append the client IP in `X-Forwarded-For` (exactly one trusted hop). Example for nginx:

   ```nginx
   location / {
     proxy_pass http://127.0.0.1:8080;
     proxy_http_version 1.1;
     proxy_set_header Upgrade $http_upgrade;
     proxy_set_header Connection "upgrade";
     proxy_set_header Host $host;
     proxy_set_header X-Forwarded-For $remote_addr;
     client_max_body_size 2g;
     proxy_request_buffering off;
     proxy_read_timeout 3600s;
   }
   ```

Platforms with ephemeral disks (Heroku-style dynos, most serverless platforms) need a persistent volume for `STORAGE_DIR`. Without one, uploaded media would be lost on restart.

## Email (sign-in codes)

Any SMTP service works. Production requires TLS: either `SMTP_SECURE=true` (port 465) or STARTTLS on port 587, which is enforced by default.

| Provider | Settings | Notes |
|---|---|---|
| Gmail / Google Workspace | `smtp.gmail.com`, port 465, `SMTP_SECURE=true`, user = the address, pass = an [app password](https://support.google.com/accounts/answer/185833) | Fine for small groups (about 500 emails per day). `MAIL_FROM` must be that address |
| Postmark, Resend, Amazon SES, Mailgun, SendGrid | Their SMTP host, port 587, `SMTP_SECURE=false` | Better deliverability. Verify your domain (SPF, DKIM, DMARC) |

Codes go to `@gmail.com` inboxes, so a properly authenticated sending domain matters: Gmail rejects or spam-folders unauthenticated mail. Test with `npm run dev:mailbox` locally first.

## Push notifications (optional)

Run `npm run vapid:generate` and set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` (a `mailto:` or https URL). Users enable notifications under Settings → Notifications. Without VAPID keys, notifications only work while a tab is open.

## Backups and restore

The `backup` service writes `cove-db-<time>.dump` and `cove-media-<time>.tar.gz` daily. Copy them off the host, for example with `restic`, `rclone` or your provider's snapshots, and encrypt them. They contain media files (which are not end-to-end encrypted) and account data. Message text inside is ciphertext.

To restore:

```bash
docker compose stop app
docker compose exec -T db pg_restore --clean --if-exists -U cove -d cove < backups/cove-db-<time>.dump
docker run --rm -v cove_app-data:/data -v "$PWD/backups:/b" alpine sh -c 'tar -C /data -xzf /b/cove-media-<time>.tar.gz'
docker compose start app
```

Users still need their own recovery keys to read messages. Backups never contain anything that decrypts message text.

## Operations

- **Health:** `GET /api/health` checks the database. It is used by the Docker `HEALTHCHECK`.
- **Logs:** JSON lines on stdout and stderr: start-up, migrations, slow (over 2 s) or failed requests, cleanup errors, email failures. They contain no bodies, query strings, codes or message content. Ship them to your log system and alert on `"level":"error"`.
- **Maintenance:** the cleanup job runs every 30 s (refunds, purges, expiry, file deletion) and hourly (old challenges, sessions, notifications, temp files).
- **Moderation:** user reports land in the `reports` table (`status` open/reviewing/actioned/dismissed), with the reporter-provided excerpt and the message ciphertext.
- **Scaling:** see ARCHITECTURE.md. Run one app replica unless you add a shared pub/sub for real-time events.
- **Secrets rotation:** changing `SESSION_SECRET` invalidates CSRF tokens (users reload). Changing `OTP_PEPPER` invalidates only codes already in flight.

## Pre-launch checklist

- [ ] `APP_ORIGIN` is the exact public `https://` origin, and DNS and TLS work.
- [ ] Two different random secrets are set. `.env` is not committed and has file mode 600.
- [ ] SMTP with TLS works, and the sending domain has SPF, DKIM and DMARC.
- [ ] `STORAGE_DIR` is on a persistent, encrypted volume. Backups run and are copied off-site and encrypted.
- [ ] The reverse proxy passes WebSockets and sets exactly one `X-Forwarded-For` hop (`TRUST_PROXY=true`).
- [ ] Upload limits suit your hardware (`MAX_*_MB`, and the proxy's body size).
- [ ] Someone monitors logs and reviews `reports`.
