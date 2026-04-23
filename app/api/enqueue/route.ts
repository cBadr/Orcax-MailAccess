// Enqueue a list of email:password accounts for asynchronous verification via QStash.
// The browser no longer needs to keep an open connection per account — it just POSTs
// the whole list, gets a batchId back, then watches /api/stream?channel=<batchId>.

import { NextRequest, NextResponse } from "next/server";
import { audit, clientMeta } from "@/lib/audit";
import { check as rateCheck, headersFor, ipFrom } from "@/lib/ratelimit";
import { enqueue, queueEnabled } from "@/lib/queue";
import { createBatch, createJob, markJobQueued } from "@/lib/store";
import { hasDb } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface Cred {
  email: string;
  password: string;
}

export async function POST(req: NextRequest) {
  if (!queueEnabled()) {
    return NextResponse.json(
      { error: "queue_not_configured", hint: "Set QSTASH_TOKEN and APP_URL (or VERCEL_URL) env vars." },
      { status: 503 },
    );
  }
  if (!hasDb()) {
    return NextResponse.json(
      { error: "database_required", hint: "Queued jobs require DATABASE_URL." },
      { status: 503 },
    );
  }

  const ip = ipFrom(req);
  const rl = await rateCheck({
    key: "enqueue:" + ip,
    limit: Number(process.env.RATE_ENQUEUE_LIMIT) || 5,
    windowSec: Number(process.env.RATE_ENQUEUE_WINDOW_SEC) || 60,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited", retryAfterSec: rl.retryAfterSec },
      { status: 429, headers: headersFor(rl) },
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400, headers: headersFor(rl) });
  }

  const creds: Cred[] = Array.isArray(body?.accounts) ? body.accounts : [];
  const protocols: string[] | undefined = Array.isArray(body?.protocols) ? body.protocols : undefined;
  const batchName: string | undefined = typeof body?.name === "string" ? body.name : undefined;

  const clean = creds.filter(
    (c) => c && typeof c.email === "string" && typeof c.password === "string" && c.email.includes("@"),
  );
  if (!clean.length) {
    return NextResponse.json({ error: "accounts must be a non-empty array of {email,password}" }, { status: 400 });
  }
  const max = Number(process.env.ENQUEUE_MAX_BATCH) || 10000;
  if (clean.length > max) {
    return NextResponse.json({ error: `too many accounts (max ${max})` }, { status: 413 });
  }

  const meta = clientMeta(req);
  await audit({ action: "enqueue.start", target: batchName ?? null, details: { count: clean.length }, ...meta });

  const batchId = await createBatch(batchName, `queued ${clean.length} accounts`);
  if (!batchId) return NextResponse.json({ error: "failed to create batch" }, { status: 500 });

  const results: { email: string; jobId: string | null; ok: boolean; error?: string }[] = [];

  // Throttle enqueue fan-out to avoid hammering QStash rate limits.
  const concurrency = Number(process.env.ENQUEUE_CONCURRENCY) || 20;
  let idx = 0;
  async function worker() {
    while (idx < clean.length) {
      const i = idx++;
      const c = clean[i];
      try {
        const jobId = await createJob("verify", { email: c.email, password: c.password, protocols, batchId }, batchId);
        if (!jobId) {
          results.push({ email: c.email, jobId: null, ok: false, error: "job row create failed" });
          continue;
        }
        const r = await enqueue({
          path: "/api/jobs/verify",
          body: { jobId, email: c.email, password: c.password, protocols, batchId },
          dedupeId: `${batchId}:${c.email}`,
          retries: Number(process.env.JOB_RETRIES) || 3,
        });
        if (r.ok && r.messageId) await markJobQueued(jobId, r.messageId);
        results.push({ email: c.email, jobId, ok: r.ok, error: r.error });
      } catch (e: any) {
        results.push({ email: c.email, jobId: null, ok: false, error: String(e?.message || e) });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, clean.length) }, worker));

  const okCount = results.filter((r) => r.ok).length;
  await audit({
    action: "enqueue.done",
    target: batchId,
    details: { count: clean.length, enqueued: okCount },
    ...meta,
  });

  return NextResponse.json(
    { batchId, enqueued: okCount, failed: clean.length - okCount, results },
    { headers: headersFor(rl) },
  );
}
