import { NextRequest, NextResponse } from "next/server";
import { discover } from "@/lib/autodiscover";
import { verifySmtp } from "@/lib/smtp";
import { verifyImap } from "@/lib/imap";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const { email, password, protocols } = body || {};
  if (typeof email !== "string" || typeof password !== "string") {
    return NextResponse.json({ error: "email and password are required" }, { status: 400 });
  }

  const wantSmtp = !protocols || protocols.includes("smtp");
  const wantImap = !protocols || protocols.includes("imap");

  const startedAt = Date.now();
  let config;
  try {
    config = await discover(email);
  } catch (e: any) {
    return NextResponse.json({
      email,
      ok: false,
      error: `discover failed: ${String(e?.message || e)}`,
    });
  }

  const [smtp, imap] = await Promise.all([
    wantSmtp ? verifySmtp(email, password, config.smtp) : Promise.resolve(null),
    wantImap ? verifyImap(email, password, config.imap) : Promise.resolve(null),
  ]);

  const ok = Boolean((smtp && smtp.ok) || (imap && imap.ok));

  return NextResponse.json({
    email,
    ok,
    smtp,
    imap,
    config: { source: config.source },
    elapsedMs: Date.now() - startedAt,
  });
}
