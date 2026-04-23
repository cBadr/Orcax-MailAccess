// QStash callback: runs a single verify job.
//
// Request: POST {jobId, email, password, protocols?, batchId?}
// Headers: upstash-signature (JWT HS256)
// Response: 200 on success/handled-error, non-2xx tells QStash to retry.

import { NextRequest, NextResponse } from "next/server";
import { verifySignature } from "@/lib/queue";
import { verifyOne } from "@/lib/verify-core";
import { markJobDone, markJobError, markJobRunning } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const raw = await req.text();

  if (process.env.QSTASH_CURRENT_SIGNING_KEY || process.env.QSTASH_NEXT_SIGNING_KEY) {
    const valid = await verifySignature(req, raw);
    if (!valid) return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  } else if (process.env.NODE_ENV === "production") {
    // Refuse unsigned calls in production even if keys weren't configured — fail closed.
    return NextResponse.json({ error: "signing keys not configured" }, { status: 500 });
  }

  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const { jobId, email, password, protocols, batchId } = payload || {};
  if (typeof email !== "string" || typeof password !== "string") {
    return NextResponse.json({ error: "email/password required" }, { status: 400 });
  }

  if (jobId) await markJobRunning(jobId).catch(() => {});

  try {
    const result = await verifyOne({ email, password, protocols, batchId });
    if (jobId) await markJobDone(jobId, result);
    return NextResponse.json({ ok: true, jobId, result });
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (jobId) await markJobError(jobId, msg).catch(() => {});
    // 500 → QStash retries per upstash-retries header configured at publish time.
    return NextResponse.json({ ok: false, jobId, error: msg }, { status: 500 });
  }
}
