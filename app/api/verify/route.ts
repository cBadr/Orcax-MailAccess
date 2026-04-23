import { NextRequest, NextResponse } from "next/server";
import { audit, clientMeta } from "@/lib/audit";
import { check as rateCheck, headersFor, ipFrom } from "@/lib/ratelimit";
import { verifyOne } from "@/lib/verify-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const ip = ipFrom(req);
  const rl = await rateCheck({
    key: "verify:" + ip,
    limit: Number(process.env.RATE_VERIFY_LIMIT) || 60,
    windowSec: Number(process.env.RATE_VERIFY_WINDOW_SEC) || 60,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited", retryAfterSec: rl.retryAfterSec, limit: rl.limit },
      { status: 429, headers: headersFor(rl) },
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400, headers: headersFor(rl) });
  }
  const { email, password, protocols, batchId } = body || {};
  if (typeof email !== "string" || typeof password !== "string") {
    return NextResponse.json({ error: "email and password are required" }, { status: 400, headers: headersFor(rl) });
  }

  const meta = clientMeta(req);
  const domain = email.split("@")[1]?.toLowerCase();
  await audit({ action: "verify.start", target: email, details: { domain, protocols }, ...meta });

  const response = await verifyOne({ email, password, protocols, batchId });

  await audit({
    action: "verify.done",
    target: email,
    details: { ok: response.ok, host: response.host, elapsedMs: response.elapsedMs },
    ...meta,
  });

  return NextResponse.json(response, { headers: headersFor(rl) });
}
