// QStash (Upstash) queue adapter.
//
// Env:
//   QSTASH_TOKEN             — publish token (required for enqueue)
//   QSTASH_CURRENT_SIGNING_KEY / QSTASH_NEXT_SIGNING_KEY — verify callbacks
//   APP_URL                  — public base URL of the deployment (Vercel URL)
//
// Flow:
//   publish(job) → POST https://qstash.upstash.io/v2/publish/<APP_URL>/api/jobs/verify
//   QStash POSTs back to /api/jobs/verify with x-upstash-signature header.
//   Worker verifies signature, does the work, updates jobs table, ACKs 200.

import { createHash, createHmac, timingSafeEqual } from "crypto";

export interface EnqueueOptions {
  /** Destination path on this app, e.g. "/api/jobs/verify". */
  path: string;
  /** JSON body for the worker endpoint. */
  body: unknown;
  /** Seconds to delay before delivery. */
  delaySec?: number;
  /** Idempotency / dedupe key forwarded to QStash. */
  dedupeId?: string;
  /** Max retries before QStash gives up (default 3). */
  retries?: number;
}

export interface EnqueueResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

export function queueEnabled(): boolean {
  return Boolean(process.env.QSTASH_TOKEN && appBaseUrl());
}

function appBaseUrl(): string | null {
  const raw = process.env.APP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null);
  if (!raw) return null;
  return raw.replace(/\/+$/, "");
}

export async function enqueue(opts: EnqueueOptions): Promise<EnqueueResult> {
  const token = process.env.QSTASH_TOKEN;
  const base = appBaseUrl();
  if (!token || !base) return { ok: false, error: "QSTASH_TOKEN or APP_URL not set" };

  const dest = base + opts.path;
  const url = `https://qstash.upstash.io/v2/publish/${encodeURIComponent(dest)}`;
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  if (opts.delaySec && opts.delaySec > 0) headers["upstash-delay"] = `${opts.delaySec}s`;
  if (opts.dedupeId) headers["upstash-deduplication-id"] = opts.dedupeId;
  if (opts.retries !== undefined) headers["upstash-retries"] = String(opts.retries);

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(opts.body),
  });
  if (!res.ok) {
    return { ok: false, error: `qstash ${res.status}: ${await res.text().catch(() => "")}` };
  }
  const json = (await res.json().catch(() => ({}))) as { messageId?: string };
  return { ok: true, messageId: json.messageId };
}

// Verify signature on an incoming QStash callback. Returns true if valid.
// Supports rotating keys (CURRENT + NEXT).
export async function verifySignature(req: Request, rawBody: string): Promise<boolean> {
  const sig = req.headers.get("upstash-signature") || req.headers.get("x-upstash-signature");
  if (!sig) return false;
  const current = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const next = process.env.QSTASH_NEXT_SIGNING_KEY;
  if (!current && !next) {
    // If signing keys aren't set, explicitly reject — never trust unsigned calls.
    return false;
  }
  for (const key of [current, next]) {
    if (!key) continue;
    if (verifyJwtHS256(sig, rawBody, key)) return true;
  }
  return false;
}

// QStash signs with JWT HS256 where the payload contains `body` = sha256(rawBody) base64url.
function verifyJwtHS256(jwt: string, rawBody: string, key: string): boolean {
  const parts = jwt.split(".");
  if (parts.length !== 3) return false;
  const [h, p, s] = parts;
  const expected = createHmac("sha256", key).update(`${h}.${p}`).digest();
  const given = b64urlDecode(s);
  if (expected.length !== given.length) return false;
  if (!timingSafeEqual(expected, given)) return false;

  const payload = JSON.parse(Buffer.from(b64urlDecode(p)).toString("utf8")) as {
    exp?: number;
    nbf?: number;
    body?: string;
  };
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && now > payload.exp + 5) return false;
  if (payload.nbf && now + 5 < payload.nbf) return false;

  if (payload.body) {
    const bodyHash = createHmacSha256Digest(rawBody);
    if (!timingSafeEqualStr(payload.body, bodyHash)) return false;
  }
  return true;
}

function b64urlDecode(s: string): Buffer {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64");
}

function createHmacSha256Digest(s: string): string {
  // QStash uses sha256(body) base64url for the `body` claim.
  return createHash("sha256").update(s).digest("base64url");
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
