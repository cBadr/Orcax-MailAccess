import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { discover } from "@/lib/autodiscover";
import { sendTest } from "@/lib/smtp";
import { audit, clientMeta } from "@/lib/audit";
import { dispatch } from "@/lib/webhooks";
import { publish } from "@/lib/events";

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
  const { email, password, to, cc, bcc, subject, text, html, attachments, fromName, replyTo, trackingId, batchId } = body || {};
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

  const tracking = typeof trackingId === "string" && trackingId ? trackingId : randomBytes(8).toString("hex");
  const meta = clientMeta(req);
  await audit({ action: "send.start", target: email, details: { to: recipients, trackingId: tracking }, ...meta });

  const config = await discover(email);
  const startedAt = Date.now();
  const result = await sendTest(email, password, config.smtp, {
    to: recipients,
    cc: Array.isArray(cc) ? cc.filter((x) => typeof x === "string" && EMAIL_RE.test(x)) : undefined,
    bcc: Array.isArray(bcc) ? bcc.filter((x) => typeof x === "string" && EMAIL_RE.test(x)) : undefined,
    subject: typeof subject === "string" ? subject : undefined,
    text: typeof text === "string" ? text : undefined,
    html: typeof html === "string" ? html : undefined,
    attachments: Array.isArray(attachments) ? attachments : undefined,
    fromName: typeof fromName === "string" ? fromName : undefined,
    replyTo: typeof replyTo === "string" ? replyTo : undefined,
    trackingId: tracking,
  });

  const response = { email, to: recipients, trackingId: tracking, ...result, elapsedMs: Date.now() - startedAt };
  publish(batchId || "*", "send.completed", response);
  await dispatch("send.completed", response).catch(() => {});
  await audit({ action: "send.done", target: email, details: { ok: result.ok, trackingId: tracking, messageId: result.messageId }, ...meta });

  return NextResponse.json(response);
}
