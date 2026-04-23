import { createHash } from "crypto";
import { ensureMigrated, hasDb, sql } from "./db";

function hashPassword(pw: string): string {
  return "sha256:" + createHash("sha256").update(pw).digest("hex");
}

export async function createBatch(name?: string, note?: string, userId?: string | null): Promise<string | null> {
  if (!hasDb()) return null;
  await ensureMigrated();
  const s = sql();
  const [row] = await s<{ id: string }[]>`
    INSERT INTO batches (user_id, name, note) VALUES (${userId ?? null}, ${name ?? null}, ${note ?? null})
    RETURNING id
  `;
  return row.id;
}

export async function ensureAccount(batchId: string, email: string, password: string): Promise<string | null> {
  if (!hasDb()) return null;
  await ensureMigrated();
  const s = sql();
  const domain = email.split("@")[1]?.toLowerCase() || null;
  const [row] = await s<{ id: string }[]>`
    INSERT INTO accounts (batch_id, email, domain, password_hash)
    VALUES (${batchId}, ${email}, ${domain}, ${hashPassword(password)})
    RETURNING id
  `;
  return row.id;
}

export interface CheckInsert {
  protocol: string;
  ok: boolean;
  host?: string;
  port?: number;
  tlsMode?: string;
  errorCategory?: string;
  errorMessage?: string;
  elapsedMs?: number;
  details?: unknown;
}

export async function recordCheck(accountId: string, c: CheckInsert): Promise<void> {
  if (!hasDb()) return;
  const s = sql();
  await s`
    INSERT INTO checks
      (account_id, protocol, ok, host, port, tls_mode, error_category, error_message, elapsed_ms, details)
    VALUES
      (${accountId}, ${c.protocol}, ${c.ok}, ${c.host ?? null}, ${c.port ?? null}, ${c.tlsMode ?? null},
       ${c.errorCategory ?? null}, ${c.errorMessage ?? null}, ${c.elapsedMs ?? null},
       ${c.details ? s.json(c.details as any) : null})
  `;
}

export async function updateAccountStatus(accountId: string, status: "valid" | "invalid" | "error"): Promise<void> {
  if (!hasDb()) return;
  const s = sql();
  await s`UPDATE accounts SET status = ${status} WHERE id = ${accountId}`;
}

export async function incrementBatch(batchId: string, field: "total" | "valid" | "invalid" | "errored", by = 1): Promise<void> {
  if (!hasDb()) return;
  const s = sql();
  if (field === "total") await s`UPDATE batches SET total = total + ${by} WHERE id = ${batchId}`;
  else if (field === "valid") await s`UPDATE batches SET valid = valid + ${by} WHERE id = ${batchId}`;
  else if (field === "invalid") await s`UPDATE batches SET invalid = invalid + ${by} WHERE id = ${batchId}`;
  else if (field === "errored") await s`UPDATE batches SET errored = errored + ${by} WHERE id = ${batchId}`;
}

export async function recordContacts(
  accountId: string,
  contacts: Array<{ email: string; name?: string; phone?: string; org?: string; source: string; folder?: string }>,
): Promise<void> {
  if (!hasDb() || !contacts.length) return;
  const s = sql();
  const values = contacts.map((c) => ({
    account_id: accountId,
    email: c.email.toLowerCase(),
    name: c.name ?? null,
    phone: c.phone ?? null,
    org: c.org ?? null,
    source: c.source,
    folder: c.folder ?? null,
  }));
  await s`
    INSERT INTO contacts ${s(values as any, "account_id", "email", "name", "phone", "org", "source", "folder")}
    ON CONFLICT (account_id, email, source) DO NOTHING
  `;
}

export interface StoredMessage {
  folder?: string;
  uid?: number;
  subject?: string;
  fromAddr?: string;
  toAddrs?: string[];
  sentAt?: Date;
  body?: string;
}

export async function recordMessages(accountId: string, msgs: StoredMessage[]): Promise<void> {
  if (!hasDb() || !msgs.length) return;
  const s = sql();
  const values = msgs.map((m) => ({
    account_id: accountId,
    folder: m.folder ?? null,
    uid: m.uid ?? null,
    subject: m.subject ?? null,
    from_addr: m.fromAddr ?? null,
    to_addrs: m.toAddrs ?? null,
    sent_at: m.sentAt ?? null,
    body: m.body ?? null,
  }));
  await s`
    INSERT INTO messages ${s(values as any, "account_id", "folder", "uid", "subject", "from_addr", "to_addrs", "sent_at", "body")}
  `;
}
