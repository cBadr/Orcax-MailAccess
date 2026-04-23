// Sliding-window rate limiter. Uses Postgres when DATABASE_URL is set;
// otherwise falls back to an in-process Map (single-instance only).
//
// API:
//   const r = await check({ key: "verify:" + ip, limit: 60, windowSec: 60 });
//   if (!r.ok) return 429(r);

import { hasDb, sql } from "./db";

export interface RateKey {
  key: string;
  limit: number;
  windowSec: number;
}

export interface RateResult {
  ok: boolean;
  remaining: number;
  limit: number;
  resetAt: number; // epoch ms when the window fully clears
  retryAfterSec: number;
}

// ---------- In-process fallback ----------
const mem = new Map<string, number[]>(); // key -> array of epoch ms

function memCheck(k: RateKey): RateResult {
  const now = Date.now();
  const windowMs = k.windowSec * 1000;
  const cutoff = now - windowMs;
  const arr = (mem.get(k.key) || []).filter((t) => t > cutoff);
  if (arr.length >= k.limit) {
    const oldest = arr[0];
    const retryAfter = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
    mem.set(k.key, arr);
    return { ok: false, remaining: 0, limit: k.limit, resetAt: oldest + windowMs, retryAfterSec: retryAfter };
  }
  arr.push(now);
  mem.set(k.key, arr);
  return { ok: true, remaining: k.limit - arr.length, limit: k.limit, resetAt: now + windowMs, retryAfterSec: 0 };
}

// ---------- Postgres-backed ----------
let migrated = false;
async function ensureTable(): Promise<void> {
  if (migrated) return;
  const s = sql();
  await s.unsafe(`
    CREATE TABLE IF NOT EXISTS rate_hits (
      key TEXT NOT NULL,
      at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_rate_hits_key_at ON rate_hits(key, at DESC);
  `);
  migrated = true;
}

async function dbCheck(k: RateKey): Promise<RateResult> {
  const s = sql();
  await ensureTable();
  // Atomic: trim old, count, insert only if under limit. Single round trip via CTE.
  // CTE snapshot semantics: siblings don't see each other's effects, so we
  // filter `cur` by the window directly (not via `del`). `del` still prunes
  // expired rows to keep the table small.
  const rows = await s<{ allowed: boolean; used: number; oldest: Date | null }[]>`
    WITH
      del AS (
        DELETE FROM rate_hits
        WHERE key = ${k.key} AND at < now() - (${k.windowSec} || ' seconds')::interval
        RETURNING 1
      ),
      cur AS (
        SELECT at FROM rate_hits
        WHERE key = ${k.key}
          AND at >= now() - (${k.windowSec} || ' seconds')::interval
      ),
      ins AS (
        INSERT INTO rate_hits (key)
        SELECT ${k.key}
        WHERE (SELECT COUNT(*) FROM cur) < ${k.limit}
        RETURNING 1
      )
    SELECT
      (SELECT COUNT(*) FROM ins) > 0 AS allowed,
      (SELECT COUNT(*) FROM cur)::int AS used,
      (SELECT MIN(at) FROM cur) AS oldest
  `;
  const row = rows[0];
  const used = row.used;
  const allowed = row.allowed;
  const nowMs = Date.now();
  const windowMs = k.windowSec * 1000;
  const oldestMs = row.oldest ? new Date(row.oldest).getTime() : nowMs;
  const resetAt = oldestMs + windowMs;
  const retryAfter = allowed ? 0 : Math.max(1, Math.ceil((resetAt - nowMs) / 1000));
  return {
    ok: allowed,
    limit: k.limit,
    remaining: Math.max(0, k.limit - used - (allowed ? 1 : 0)),
    resetAt,
    retryAfterSec: retryAfter,
  };
}

export async function check(k: RateKey): Promise<RateResult> {
  try {
    if (hasDb()) return await dbCheck(k);
  } catch {
    // fall through to memory on transient DB errors
  }
  return memCheck(k);
}

// Helpers to derive keys.
export function ipFrom(req: Request | { headers: Headers }): string {
  const h = (req as any).headers as Headers;
  const xf = h.get("x-forwarded-for");
  if (xf) return xf.split(",")[0].trim();
  return h.get("x-real-ip") || "unknown";
}

export function headersFor(r: RateResult): Record<string, string> {
  return {
    "x-ratelimit-limit": String(r.limit),
    "x-ratelimit-remaining": String(r.remaining),
    "x-ratelimit-reset": String(Math.floor(r.resetAt / 1000)),
    ...(r.ok ? {} : { "retry-after": String(r.retryAfterSec) }),
  };
}
