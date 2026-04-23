// Shared verify pipeline. Used by both the direct /api/verify route,
// the QStash worker /api/jobs/verify, and the worker_threads pool.

import { discover } from "./autodiscover";
import { verifySmtp } from "./smtp";
import { verifyImap } from "./imap";
import { verifyPop3 } from "./pop3";
import { ensureAccount, incrementBatch, recordCheck, updateAccountStatus } from "./store";
import { publish } from "./events";
import { dispatch } from "./webhooks";

export interface VerifyInput {
  email: string;
  password: string;
  protocols?: string[];
  batchId?: string | null;
}

export interface VerifyOutput {
  email: string;
  ok: boolean;
  smtp: any;
  imap: any;
  pop3: any;
  config: { source: string; smtpHosts: number; imapHosts: number; pop3Hosts: number };
  elapsedMs: number;
  host?: string;
  error?: string;
}

export async function verifyOne(input: VerifyInput): Promise<VerifyOutput> {
  const { email, password, protocols, batchId } = input;
  const wantSmtp = !protocols || protocols.includes("smtp");
  const wantImap = !protocols || protocols.includes("imap");
  const wantPop3 = protocols?.includes("pop3") ?? false;

  const startedAt = Date.now();

  let config;
  try {
    config = await discover(email);
  } catch (e: any) {
    return {
      email,
      ok: false,
      smtp: null,
      imap: null,
      pop3: null,
      config: { source: "error", smtpHosts: 0, imapHosts: 0, pop3Hosts: 0 },
      elapsedMs: Date.now() - startedAt,
      error: `discover failed: ${String(e?.message || e)}`,
    };
  }

  const [smtp, imap, pop3] = await Promise.all([
    wantSmtp ? verifySmtp(email, password, config.smtp) : Promise.resolve(null),
    wantImap ? verifyImap(email, password, config.imap) : Promise.resolve(null),
    wantPop3 ? verifyPop3(email, password, config.pop3) : Promise.resolve(null),
  ]);

  const ok = Boolean((smtp && smtp.ok) || (imap && imap.ok) || (pop3 && pop3.ok));
  const host = imap?.host || smtp?.host || pop3?.host;

  const response: VerifyOutput = {
    email,
    ok,
    smtp,
    imap,
    pop3,
    config: { source: config.source, smtpHosts: config.smtp.length, imapHosts: config.imap.length, pop3Hosts: config.pop3.length },
    elapsedMs: Date.now() - startedAt,
    host,
  };

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

  const evt = { ...response, batchId };
  publish(batchId || "*", "check.completed", evt);
  await dispatch("check.completed", evt).catch(() => {});

  return response;
}
