import { NextRequest, NextResponse } from "next/server";
import { discover } from "@/lib/autodiscover";
import { verifySmtp } from "@/lib/smtp";
import { verifyImap } from "@/lib/imap";
import { verifyPop3 } from "@/lib/pop3";
import { audit, clientMeta } from "@/lib/audit";
import { dispatch } from "@/lib/webhooks";
import { publish } from "@/lib/events";
import { ensureAccount, incrementBatch, recordCheck, updateAccountStatus } from "@/lib/store";

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
  const { email, password, protocols, batchId } = body || {};
  if (typeof email !== "string" || typeof password !== "string") {
    return NextResponse.json({ error: "email and password are required" }, { status: 400 });
  }

  const wantSmtp = !protocols || protocols.includes("smtp");
  const wantImap = !protocols || protocols.includes("imap");
  const wantPop3 = protocols?.includes("pop3") ?? false;

  const startedAt = Date.now();
  const meta = clientMeta(req);
  const domain = email.split("@")[1]?.toLowerCase();

  await audit({ action: "verify.start", target: email, details: { domain, protocols: { smtp: wantSmtp, imap: wantImap, pop3: wantPop3 } }, ...meta });

  let config;
  try {
    config = await discover(email);
  } catch (e: any) {
    const payload = { email, ok: false, error: `discover failed: ${String(e?.message || e)}` };
    return NextResponse.json(payload);
  }

  const [smtp, imap, pop3] = await Promise.all([
    wantSmtp ? verifySmtp(email, password, config.smtp) : Promise.resolve(null),
    wantImap ? verifyImap(email, password, config.imap) : Promise.resolve(null),
    wantPop3 ? verifyPop3(email, password, config.pop3) : Promise.resolve(null),
  ]);

  const ok = Boolean((smtp && smtp.ok) || (imap && imap.ok) || (pop3 && pop3.ok));
  const host = imap?.host || smtp?.host || pop3?.host;

  const response = {
    email,
    ok,
    smtp,
    imap,
    pop3,
    config: { source: config.source, smtpHosts: config.smtp.length, imapHosts: config.imap.length, pop3Hosts: config.pop3.length },
    elapsedMs: Date.now() - startedAt,
  };

  // Persist + notify (no-ops if DB not configured).
  if (batchId) {
    const accountId = await ensureAccount(batchId, email, password);
    await incrementBatch(batchId, "total");
    if (accountId) {
      const writes: Promise<any>[] = [];
      if (smtp) writes.push(recordCheck(accountId, { protocol: "smtp", ok: smtp.ok, host: smtp.host, port: smtp.port, tlsMode: smtp.tlsMode, errorCategory: smtp.error?.category, errorMessage: smtp.error?.message }));
      if (imap) writes.push(recordCheck(accountId, { protocol: "imap", ok: imap.ok, host: imap.host, port: imap.port, tlsMode: imap.tlsMode, errorCategory: imap.error?.category, errorMessage: imap.error?.message }));
      if (pop3) writes.push(recordCheck(accountId, { protocol: "pop3", ok: pop3.ok, host: pop3.host, port: pop3.port, tlsMode: pop3.secure ? "implicit" : "starttls", errorCategory: pop3.error?.category, errorMessage: pop3.error?.message, details: { messageCount: pop3.messageCount, mailboxSizeBytes: pop3.mailboxSizeBytes } }));
      writes.push(updateAccountStatus(accountId, ok ? "valid" : "invalid"));
      writes.push(incrementBatch(batchId, ok ? "valid" : "invalid"));
      await Promise.all(writes);
    }
  }

  const evt = { ...response, batchId, host };
  publish(batchId || "*", "check.completed", evt);
  await dispatch("check.completed", evt).catch(() => {});
  await audit({ action: "verify.done", target: email, details: { ok, host, elapsedMs: response.elapsedMs }, ...meta });

  return NextResponse.json(response);
}
