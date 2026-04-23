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

// ---------- Jobs (queue) ----------

export interface JobRow {
  id: string;
  kind: string;
  status: string;
  batch_id: string | null;
  attempts: number;
  result: unknown;
  error: string | null;
}

export async function createJob(kind: "verify" | "send", payload: unknown, batchId?: string | null): Promise<string | null> {
  if (!hasDb()) return null;
  await ensureMigrated();
  const s = sql();
  const [row] = await s<{ id: string }[]>`
    INSERT INTO jobs (kind, payload, batch_id)
    VALUES (${kind}, ${s.json(payload as any)}, ${batchId ?? null})
    RETURNING id
  `;
  return row.id;
}

export async function markJobQueued(jobId: string, messageId: string): Promise<void> {
  if (!hasDb()) return;
  const s = sql();
  await s`UPDATE jobs SET message_id = ${messageId} WHERE id = ${jobId}`;
}

export async function markJobRunning(jobId: string): Promise<void> {
  if (!hasDb()) return;
  const s = sql();
  await s`UPDATE jobs SET status = 'running', started_at = now(), attempts = attempts + 1 WHERE id = ${jobId}`;
}

export async function markJobDone(jobId: string, result: unknown): Promise<void> {
  if (!hasDb()) return;
  const s = sql();
  await s`
    UPDATE jobs
    SET status = 'done', finished_at = now(), result = ${s.json(result as any)}
    WHERE id = ${jobId}
  `;
}

export async function markJobError(jobId: string, err: string): Promise<void> {
  if (!hasDb()) return;
  const s = sql();
  await s`
    UPDATE jobs SET status = 'error', finished_at = now(), error = ${err}
    WHERE id = ${jobId}
  `;
}

export async function jobStatus(jobId: string): Promise<JobRow | null> {
  if (!hasDb()) return null;
  const s = sql();
  const rows = await s<JobRow[]>`
    SELECT id, kind, status, batch_id, attempts, result, error
    FROM jobs WHERE id = ${jobId}
  `;
  return rows[0] || null;
}

export async function batchJobSummary(batchId: string): Promise<{ queued: number; running: number; done: number; error: number }> {
  if (!hasDb()) return { queued: 0, running: 0, done: 0, error: 0 };
  const s = sql();
  const rows = await s<{ status: string; n: number }[]>`
    SELECT status, COUNT(*)::int AS n FROM jobs WHERE batch_id = ${batchId} GROUP BY status
  `;
  const out = { queued: 0, running: 0, done: 0, error: 0 } as Record<string, number>;
  for (const r of rows) out[r.status] = r.n;
  return out as any;
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
