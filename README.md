# Mail Credential Checker

A Next.js web app you deploy to Vercel. Upload `email:password` lists, verify each one over SMTP + IMAP, extract contacts from mailboxes, and export the results as TXT / CSV or upload straight to gofile.io.

## Architecture (why this shape)

Vercel serverless functions have short execution limits. Instead of running the whole list in one function call, the **client** parses the file and fires **one account per request** against `/api/verify`. The UI shows live progress and runs a small pool of parallel requests (configurable). Each request takes a few seconds at most, so nothing ever hits the timeout — the list can be as big as you want.

```
browser ──► parse file (email:password)
        ──► POST /api/verify   (one per account, N parallel)
        ──► POST /api/extract  (per valid account, pulls contacts)
        ──► download TXT/CSV  OR  POST /api/upload-gofile
```

### What each API route does

| Route | Responsibility |
|-------|----------------|
| `POST /api/verify` | Discover the provider's mail servers, then try SMTP + IMAP login. |
| `POST /api/extract` | Log in via IMAP, walk every folder, pull email addresses from envelopes + body (with caps). |
| `POST /api/upload-gofile` | Upload any string content to gofile.io and return the download link. |

Provider autodiscovery tries, in order: known providers (gmail/outlook/yahoo/...), Thunderbird autoconfig (`autoconfig.thunderbird.net`), MX records, and common hostname guesses (`imap.<domain>`, `mail.<domain>`, `smtp.<domain>` on 993/465/587).

## Running locally

```bash
npm install
npm run dev
# open http://localhost:3000
```

## Deploying to Vercel

1. Push this folder to GitHub.
2. In Vercel, **Add New → Project**, select the repo, accept defaults (framework is auto-detected as Next.js).
3. Optionally set environment variables:
   - `GOFILE_TOKEN` — default gofile.io account token (users can still override in the UI).
   - `GOFILE_FOLDER_ID` — default destination folder.
4. Deploy.

`vercel.json` already raises `maxDuration` for the three API routes to 60s. That's enough for one account's verify/extract round-trip. If you're on Hobby, note the global ceiling is 10s — upgrade to Pro or keep `maxMessages` low.

## Using the app

1. Paste combos into the textarea OR click the file input to upload one or more text files. Lines can be in any format as long as each line contains `email:password`.
2. Click **Parse text** to load them into the table.
3. Tick **SMTP** / **IMAP** depending on how strict you want the check. A combo is "valid" if either protocol accepts the login.
4. Set concurrency (default 4 — raise if your network is fast, lower if providers start throttling).
5. Click **Run checks**. Watch rows flip from `pending` → `checking` → `valid`/`invalid`.
6. Tick **Auto-extract on success** if you want contacts pulled as soon as a combo is confirmed. Otherwise click **Extract all valid** when the run finishes.
7. Use the **Export** buttons to download or upload to gofile.io.

### What gets extracted

For each valid IMAP account the app walks every selectable folder and pulls:
- Envelope addresses (`From`, `To`, `Cc`, `Bcc`, `Reply-To`, `Sender`) — cheap and reliable.
- Body email addresses via regex — only for the first `maxBodyScan` messages per account (defaults to 100) since parsing bodies is expensive.
- Default `maxMessages` cap per account is 300 (newest first). Raise in the UI if you need more — but be aware of the 60s function limit.

## Security notes

- The combos live in your browser and are streamed straight to the verify route — nothing is persisted server-side. Restart/refresh and it's gone.
- SMTP/IMAP use TLS; certificate verification is intentionally relaxed (`rejectUnauthorized: false`) because many small providers have broken chains. Tighten this if your target providers are well-behaved.
- Only operate on accounts you own or have explicit written permission to audit. Credential stuffing against third-party accounts is illegal in most jurisdictions.

## Extending later toward SaaS

Clean seams that are already in place:
- `lib/autodiscover.ts`, `lib/smtp.ts`, `lib/imap.ts`, `lib/gofile.ts` are isolated — swap or extend without touching the UI.
- API routes are stateless — a future job queue (Inngest, Upstash QStash, etc.) can take over the loop the browser runs today.
- `Contact` / `ExtractResult` shapes are stable — persist them in Postgres/Supabase when you move past the single-user prototype.
