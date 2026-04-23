import { NextRequest, NextResponse } from "next/server";
import { discover } from "@/lib/autodiscover";
import { sendTest } from "@/lib/smtp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const { email, password, to, subject, text, html, fromName } = body || {};
  if (typeof email !== "string" || typeof password !== "string") {
    return NextResponse.json({ error: "email and password are required" }, { status: 400 });
  }
  if (!Array.isArray(to) || !to.length) {
    return NextResponse.json({ error: "to must be a non-empty array" }, { status: 400 });
  }
  const recipients = to.filter((x) => typeof x === "string" && EMAIL_RE.test(x.trim()));
  if (!recipients.length) {
    return NextResponse.json({ error: "no valid recipients" }, { status: 400 });
  }

  const config = await discover(email);
  const startedAt = Date.now();
  const result = await sendTest(email, password, config.smtp, {
    to: recipients,
    subject: typeof subject === "string" ? subject : undefined,
    text: typeof text === "string" ? text : undefined,
    html: typeof html === "string" ? html : undefined,
    fromName: typeof fromName === "string" ? fromName : undefined,
  });

  return NextResponse.json({ email, to: recipients, ...result, elapsedMs: Date.now() - startedAt });
}
