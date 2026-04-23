// Verify a batch of accounts in one request using a bounded-concurrency pool
// (and optionally real worker_threads when WORKER_THREADS=1).
//
// For very large lists use /api/enqueue instead — this route stays within the
// function's maxDuration.

import { NextRequest, NextResponse } from "next/server";
import { audit, clientMeta } from "@/lib/audit";
import { check as rateCheck, headersFor, ipFrom } from "@/lib/ratelimit";
import { createBatch } from "@/lib/store";
import { runPool } from "@/lib/pool";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const ip = ipFrom(req);
  const rl = await rateCheck({
    key: "verify-batch:" + ip,
    limit: Number(process.env.RATE_BATCH_LIMIT) || 10,
    windowSec: Number(process.env.RATE_BATCH_WINDOW_SEC) || 60,
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
  const accounts = Array.isArray(body?.accounts) ? body.accounts : [];
  const protocols = Array.isArray(body?.protocols) ? body.protocols : undefined;
  const concurrency = Number(body?.concurrency) || Number(process.env.POOL_CONCURRENCY) || 16;

  const clean = accounts.filter(
    (c: any) => c && typeof c.email === "string" && typeof c.password === "string" && c.email.includes("@"),
  );
  if (!clean.length) {
    return NextResponse.json({ error: "accounts must be a non-empty array of {email,password}" }, { status: 400 });
  }
  const max = Number(process.env.VERIFY_BATCH_MAX) || 500;
  if (clean.length > max) {
    return NextResponse.json(
      { error: `too many accounts (max ${max}); use /api/enqueue for larger lists` },
      { status: 413 },
    );
  }

  const meta = clientMeta(req);
  const batchId = (await createBatch(body?.name, `batch ${clean.length} accounts`)) || undefined;
  await audit({ action: "verify-batch.start", target: batchId ?? null, details: { count: clean.length, concurrency }, ...meta });

  const startedAt = Date.now();
  const inputs = clean.map((c: any) => ({ email: c.email, password: c.password, protocols, batchId }));
  const results = await runPool(inputs, { concurrency });

  const ok = results.filter((r) => r.ok).length;
  await audit({
    action: "verify-batch.done",
    target: batchId ?? null,
    details: { count: clean.length, ok, elapsedMs: Date.now() - startedAt },
    ...meta,
  });

  return NextResponse.json(
    {
      batchId,
      count: clean.length,
      ok,
      failed: clean.length - ok,
      elapsedMs: Date.now() - startedAt,
      threaded: process.env.WORKER_THREADS === "1",
      results,
    },
    { headers: headersFor(rl) },
  );
}
