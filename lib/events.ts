// Pub/sub for SSE.
//
// Backends (auto-selected):
//   1. Postgres LISTEN/NOTIFY when DATABASE_URL is set — multi-instance safe.
//   2. In-process Map fallback — single-instance dev mode.
//
// Public interface is unchanged: subscribe(channel, listener) / publish(channel, event, data).
// A process-wide broadcast channel "*" receives every event.

import postgres from "postgres";
import { hasDb } from "./db";

type Listener = (event: string, data: unknown) => void;

const local = new Map<string, Set<Listener>>();

function localSubscribe(channel: string, listener: Listener): () => void {
  let set = local.get(channel);
  if (!set) {
    set = new Set();
    local.set(channel, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) local.delete(channel);
  };
}

function localPublish(channel: string, event: string, data: unknown): void {
  const fan = (ch: string) => {
    const set = local.get(ch);
    if (!set) return;
    for (const l of set) { try { l(event, data); } catch {} }
  };
  fan(channel);
  if (channel !== "*") fan("*");
}

// ---------- Postgres LISTEN/NOTIFY backend ----------
// A single dedicated connection per process is used for LISTEN — postgres.js
// opens it lazily on first .listen() call and keeps it open.

const PG_CHANNEL = "mailchecker_events";
const SELF_ID = Math.random().toString(36).slice(2) + Date.now().toString(36);
let pgListener: ReturnType<typeof postgres> | null = null;
let pgListenerReady: Promise<void> | null = null;

function pgConn() {
  if (pgListener) return pgListener;
  const url = process.env.DATABASE_URL!;
  pgListener = postgres(url, {
    ssl: /localhost|127\.0\.0\.1/.test(url) ? false : "require",
    max: 1,
    idle_timeout: 0,
    max_lifetime: 0,
    prepare: false,
  });
  return pgListener;
}

async function ensurePgListen(): Promise<void> {
  if (pgListenerReady) return pgListenerReady;
  pgListenerReady = (async () => {
    const s = pgConn();
    await s.listen(PG_CHANNEL, (payload) => {
      try {
        const msg = JSON.parse(payload) as { s: string; c: string; e: string; d: unknown };
        if (msg.s === SELF_ID) return; // publisher already delivered locally
        localPublish(msg.c, msg.e, msg.d);
      } catch {
        // ignore malformed payload
      }
    });
  })();
  return pgListenerReady;
}

// NOTIFY payload size limit is ~8 KB; we serialize compactly and drop oversized data.
function pgNotify(channel: string, event: string, data: unknown): void {
  const body = JSON.stringify({ s: SELF_ID, c: channel, e: event, d: data });
  if (body.length > 7500) {
    const lean = JSON.stringify({ s: SELF_ID, c: channel, e: event, d: { _truncated: true } });
    void pgConn().unsafe(`NOTIFY ${PG_CHANNEL}, '${lean.replace(/'/g, "''")}'`).catch(() => {});
    return;
  }
  void pgConn().unsafe(`NOTIFY ${PG_CHANNEL}, '${body.replace(/'/g, "''")}'`).catch(() => {});
}

// ---------- Public API ----------

export function subscribe(channel: string, listener: Listener): () => void {
  if (hasDb()) {
    // Ensure the listener connection is up; we still deliver via the local map
    // (which pgListen populates on NOTIFY).
    void ensurePgListen().catch(() => {});
  }
  return localSubscribe(channel, listener);
}

export function publish(channel: string, event: string, data: unknown): void {
  // Deliver locally first for same-process subscribers (no round trip).
  localPublish(channel, event, data);
  if (hasDb()) {
    // Broadcast to peers. They will re-enter localPublish via the LISTEN callback,
    // but we guard against double-delivery by skipping the local map there — actually
    // we *do* want them to deliver to their local subscribers. Only the publisher
    // has already delivered locally, so peers see it exactly once.
    pgNotify(channel, event, data);
  }
}
