# Mail Credential Checker

A Next.js web app (Vercel-ready) for auditing `email:password` combos. Verifies credentials over **SMTP / IMAP / POP3**, scores the domain for **SPF / DKIM / DMARC**, sends test messages (HTML + attachments + traceable Message-ID), extracts contacts from both **IMAP mailboxes and CardDAV address books**, exports to TXT/CSV or **gofile.io**, and — when `DATABASE_URL` is set — persists everything to Postgres with a live **SSE dashboard**, **full-text search**, **audit log**, and outbound **webhooks**.

## Architecture

```
browser ──► parse file (email:password)
        ──► POST /api/verify        (SMTP + IMAP + POP3 per account, N parallel)
        ──► POST /api/send-test     (HTML + attachments + trackingId → Message-ID)
        ──► POST /api/extract       (IMAP walk + CardDAV)
        ──► POST /api/dns-auth      (SPF/DKIM/DMARC + heuristic score)
        ──► POST /api/deliverability (Mail-Tester / GlockApps)
        ──► GET  /api/stream        (Server-Sent Events for live updates)
        ──► POST /api/upload-gofile (TXT/CSV to gofile.io)

Postgres (optional) ──► batches, accounts, checks, contacts, messages (FTS),
                        audit_events, webhooks, webhook_deliveries
```

One HTTP request per account keeps every function invocation short — the list can be arbitrarily large without hitting Vercel's per-function timeout.

## Feature map

| Area | Module |
|------|--------|
| Credential parse + dedupe | [lib/parse.ts](lib/parse.ts) |
| Server autodiscovery (known, Thunderbird autoconfig, SRV, MX, guess) | [lib/autodiscover.ts](lib/autodiscover.ts) |
| SMTP verify + send (HTML, attachments, Message-ID, trackingId) | [lib/smtp.ts](lib/smtp.ts) |
| IMAP verify + contact/address extraction | [lib/imap.ts](lib/imap.ts) |
| POP3 verify (raw TCP + STLS upgrade) | [lib/pop3.ts](lib/pop3.ts) |
| Error categorization | [lib/errors.ts](lib/errors.ts) |
| SPF / DKIM / DMARC + deliverability score | [lib/dns-auth.ts](lib/dns-auth.ts) |
| Mail-Tester / GlockApps adapters | [lib/deliverability.ts](lib/deliverability.ts) |
| CardDAV contact crawler | [lib/carddav.ts](lib/carddav.ts) |
| Postgres + auto-migrations | [lib/db.ts](lib/db.ts) |
| Persistence helpers (batches, accounts, checks, contacts, messages) | [lib/store.ts](lib/store.ts) |
| Audit log | [lib/audit.ts](lib/audit.ts) |
| Webhooks (HMAC-signed, persisted deliveries) | [lib/webhooks.ts](lib/webhooks.ts) |
| In-process pub/sub for SSE | [lib/events.ts](lib/events.ts) |
| gofile.io client | [lib/gofile.ts](lib/gofile.ts) |
| Analytics dashboard | [app/dashboard/page.tsx](app/dashboard/page.tsx) |

## TLS mode auto-selection

Each `MailHost` now carries `tlsMode: "implicit" | "starttls" | "plain"`. Autodiscovery generates candidates for *all three* on standard ports (993/143 IMAP, 995/110 POP3, 465/587/25 SMTP) — the verifier walks them in order and stops at the first success. Known providers are pinned to their correct mode, so we don't waste round trips.

## Error categories

Every failure is tagged with one of:

```
auth_failed · 2fa_required · app_password_required · rate_limited
tls_error · cert_error · host_unreachable · dns_error
connection_timeout · protocol_error · quota_exceeded · relay_denied
sender_rejected · recipient_rejected · unknown
```

Definitive categories (`auth_failed`, `2fa_required`, `quota_exceeded`, …) short-circuit host-walking: no point retrying a different port if the server just said "wrong password." The categorized value flows through to the table, dashboard, and webhook payloads.

## Send test with HTML + attachments + trackable Message-ID

Every outgoing test email:
- Uses `From: "<fromName>" <email>` with optional `Reply-To`.
- Accepts plain text, HTML, and a list of `{filename, content, isBase64, contentType}` attachments.
- Generates a deterministic `Message-ID: <trackingId@mailchecker.<domain>>`.
- Adds `X-Tracking-Id: <trackingId>` header so you can find the message in any intermediary's logs.
- Reports `accepted`, `rejected`, and the full SMTP `response` string.

## Deliverability integrations

| Provider | Flow |
|----------|------|
| **Mail-Tester** | Get a unique address from `mail-tester.com`, pass it as a recipient, then call `/api/deliverability` with `{ provider: "mail-tester", testId, fetch: true }` (token required for JSON, otherwise just open the report URL). |
| **GlockApps** | `/api/deliverability` `{ provider: "glockapps", action: "start" }` returns seeds + testId; send your test to those seeds, then `{ action: "fetch", testId }` to grab the score/placement. |

Both APIs return the same `{ ok, score, maxScore, inboxPlacement, reportUrl }` shape.

## Contact extraction — all sources

Calling `/api/extract` with `{ includeCardDav: true }` runs two crawlers in parallel:

1. **IMAP**: walks every selectable folder, pulls addresses from envelopes (From/To/Cc/Bcc/Reply-To/Sender) and — for up to `maxBodyScan` messages — regex-scans the body.
2. **CardDAV**: discovers the address-book home via `/.well-known/carddav` + PROPFIND, enumerates collections, REPORTs vCards, and parses `FN`, `EMAIL`, `TEL`, `ORG`.

Results are merged/deduped and each contact carries `{email, name, phone, org, source, folder}`.

## Full-text search

When `DATABASE_URL` is set, `messages.tsv` is a generated `tsvector` across subject + from + to + body with a GIN index. `/api/search?q=...` uses `plainto_tsquery` + `ts_headline` for safe snippeted results.

## SSE (Server-Sent Events)

`GET /api/stream?channel=<batchId-or-*>` streams every event (`check.completed`, `send.completed`, `extract.completed`) as it happens. The current UI uses client-driven polling, but the stream is already wired — you can close the browser, reopen `/dashboard`, and watch a running batch live. Switch to Postgres LISTEN/NOTIFY or Upstash when going multi-instance (same [events.ts](lib/events.ts) interface).

## Audit log

Every API route (verify/extract/send/dns-auth/webhooks/batches) records `{actor, action, target, ip, user_agent, details, created_at}` into `audit_events`. Audit never throws — DB outages never block the main flow.

## Webhooks

`POST /api/webhooks { url, events? }` registers a URL + generated secret. On each event we POST:

```
POST <url>
x-webhook-event: check.completed
x-webhook-signature: t=<unix>,v1=<hmac-sha256(secret, "<t>.<body>")>

{ "event": "...", "data": { ... }, "at": "..." }
```

Deliveries (status, response snippet, success) are written to `webhook_deliveries` for later inspection. Events supported: `check.completed`, `send.completed`, `extract.completed` (use `"*"` for all).

## Dashboard

`/dashboard` shows:
- Totals + success rate
- Top providers by domain
- Error category distribution
- TLD distribution
- Fastest successful hosts (per protocol)
- TLS mode success matrix
- Recent accounts

Polls `/api/dashboard` every 10s.

## Setup

```bash
npm install
cp .env.example .env.local   # fill DATABASE_URL if you want persistence
npm run dev
# http://localhost:3000            — checker
# http://localhost:3000/dashboard  — analytics (requires DATABASE_URL)
```

## Vercel deploy

1. Push to GitHub.
2. Import in Vercel (zero config — Next.js auto-detected).
3. Add env vars: `DATABASE_URL` (Neon / Supabase free tier works), optionally `GOFILE_TOKEN`, `GOFILE_FOLDER_ID`, `MAILTESTER_TOKEN`, `GLOCKAPPS_KEY`.
4. On the first request the app auto-creates its schema (idempotent `CREATE TABLE IF NOT EXISTS`).

`vercel.json` sets `maxDuration: 60` for request routes and `300` for the SSE stream. Hobby plan caps functions at 10s — upgrade to Pro or lower `maxMessages` per extract.

## Security notes

- Passwords are hashed (`sha256:...`) before insert into `accounts.password_hash`; the raw password is never persisted. The live verify request still carries them in memory — use HTTPS only.
- TLS cert verification is relaxed (`rejectUnauthorized: false`) to accommodate small providers with broken chains. Tighten if your targets are well-behaved.
- Webhook signatures use HMAC-SHA256 with a per-webhook secret. Verify on the receiving side with `t=...,v1=...` split and a constant-time compare.
- Only audit accounts you own or have explicit written permission to test.

## Queue mode (QStash)

For large lists, skip the per-account HTTP fanout from the browser. Instead:

```
POST /api/enqueue  { name, accounts: [{email,password}, ...], protocols? }
  → { batchId, enqueued, failed, results: [...] }

GET  /api/jobs/status?batchId=<id>     → { queued, running, done, error }
GET  /api/jobs/status?jobId=<id>       → single job row
GET  /api/stream?channel=<batchId>     → SSE live feed (check.completed events)
```

`/api/enqueue` creates a `batches` row, writes one `jobs` row per account, and publishes to **Upstash QStash**. QStash fans them back to `/api/jobs/verify` — one short invocation per account, so nothing hits Vercel's per-function timeout regardless of list size. The browser just polls `/api/jobs/status` or watches SSE.

Required env:

```
QSTASH_TOKEN=...                     # publish token (Upstash console)
QSTASH_CURRENT_SIGNING_KEY=...       # verify callbacks
QSTASH_NEXT_SIGNING_KEY=...          # (rotation)
APP_URL=https://your-app.vercel.app  # public URL QStash calls back
DATABASE_URL=...                     # required for queue mode (persists jobs)
```

## Multi-instance pub/sub

`lib/events.ts` auto-selects:
- **Postgres `LISTEN/NOTIFY`** when `DATABASE_URL` is set — multiple lambdas stay in sync, so the SSE stream works no matter which instance received the publish.
- **In-process Map** fallback when DB is absent (dev only).

A self-ID on each publish prevents double-delivery to the publishing instance.

> **Note**: `LISTEN/NOTIFY` needs a **session-mode** connection. If `DATABASE_URL` points to a transaction-pooled endpoint (Neon pooler `-pooler.neon`, Supabase `*pooler*:6543`), set `DATABASE_URL_DIRECT` to the direct-connection URL and use it for this module — or fall back to Upstash Redis pub/sub by replacing the backend in `lib/events.ts`.

## Multi-threaded batch verify

`POST /api/verify-batch { accounts: [...], concurrency?: 16 }` runs a bounded-concurrency pool over one request. Accounts are processed in parallel up to `concurrency`. Results stream in real time via `publish()` into the SSE channel while the request is still open.

Set `WORKER_THREADS=1` (self-hosted / Docker, multi-vCPU) to spawn real `worker_threads` and spread the work across cores. On Vercel (single-vCPU lambdas) the async pool already saturates the event loop for I/O-bound verify, so threads add little there — the feature is available when you go beyond Vercel.

Route caps:
- `/api/verify-batch`: up to `VERIFY_BATCH_MAX` accounts (default 500), `maxDuration=300`.
- `/api/enqueue`: up to `ENQUEUE_MAX_BATCH` accounts (default 10000).

## Rate limiting

Sliding-window limiter on every write endpoint:

| Route | Env override (limit / windowSec) | Default |
|-------|----------------------------------|---------|
| `/api/verify` | `RATE_VERIFY_LIMIT` / `RATE_VERIFY_WINDOW_SEC` | 60 per 60s |
| `/api/send-test` | `RATE_SEND_LIMIT` / `RATE_SEND_WINDOW_SEC` | 10 per 60s |
| `/api/verify-batch` | `RATE_BATCH_LIMIT` / `RATE_BATCH_WINDOW_SEC` | 10 per 60s |
| `/api/enqueue` | `RATE_ENQUEUE_LIMIT` / `RATE_ENQUEUE_WINDOW_SEC` | 5 per 60s |

Backed by a `rate_hits` table (atomic CTE: trim + count + insert in one round trip), falls back to an in-memory Map if the DB is unreachable. Keys are per-IP (`x-forwarded-for`). Every response carries `x-ratelimit-*` headers; 429s include `retry-after`.

## Extending toward SaaS

Clean seams:
- `lib/events.ts` → swap in Postgres LISTEN/NOTIFY or Upstash Redis for multi-instance fan-out.
- `lib/webhooks.ts` → add retry/backoff from `webhook_deliveries` for at-least-once semantics.
- Add OAuth2 / XOAUTH2 to `lib/smtp.ts` + `lib/imap.ts` (nodemailer + imapflow both support it).
- Promote the `users` table to a real auth layer (e.g. Lucia, Clerk) and gate everything by `user_id`.
- Replace in-browser worker pool with Inngest or QStash jobs that re-use these same API routes.
