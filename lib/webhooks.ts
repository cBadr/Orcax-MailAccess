import { createHmac, randomBytes } from "crypto";
import { ensureMigrated, hasDb, sql } from "./db";

export interface Webhook {
  id: string;
  user_id?: string | null;
  url: string;
  secret: string;
  events: string[];
  active: boolean;
}

export function newSecret(): string {
  return randomBytes(32).toString("hex");
}

export function sign(secret: string, body: string, timestamp: number): string {
  const h = createHmac("sha256", secret);
  h.update(`${timestamp}.${body}`);
  return `t=${timestamp},v1=${h.digest("hex")}`;
}

export async function listWebhooks(userId?: string | null): Promise<Webhook[]> {
  if (!hasDb()) return [];
  await ensureMigrated();
  const s = sql();
  const rows = userId
    ? await s<Webhook[]>`SELECT id, user_id, url, secret, events, active FROM webhooks WHERE user_id = ${userId} AND active`
    : await s<Webhook[]>`SELECT id, user_id, url, secret, events, active FROM webhooks WHERE active`;
  return rows as unknown as Webhook[];
}

export async function createWebhook(url: string, events: string[], userId?: string | null): Promise<Webhook> {
  await ensureMigrated();
  const s = sql();
  const secret = newSecret();
  const [row] = await s<Webhook[]>`
    INSERT INTO webhooks (user_id, url, secret, events, active)
    VALUES (${userId ?? null}, ${url}, ${secret}, ${events}, true)
    RETURNING id, user_id, url, secret, events, active
  `;
  return row as unknown as Webhook;
}

export async function deleteWebhook(id: string): Promise<void> {
  await ensureMigrated();
  const s = sql();
  await s`DELETE FROM webhooks WHERE id = ${id}`;
}

async function recordDelivery(
  webhookId: string,
  event: string,
  payload: unknown,
  status?: number,
  snippet?: string,
  success = false,
) {
  if (!hasDb()) return;
  const s = sql();
  await s`
    INSERT INTO webhook_deliveries (webhook_id, event, payload, status_code, response_snippet, success)
    VALUES (${webhookId}, ${event}, ${s.json(payload as any)}, ${status ?? null}, ${snippet ?? null}, ${success})
  `.catch(() => {});
}

async function deliverOne(wh: Webhook, event: string, payload: unknown, timeoutMs = 5000): Promise<void> {
  const body = JSON.stringify({ event, data: payload, at: new Date().toISOString() });
  const ts = Math.floor(Date.now() / 1000);
  const sig = sign(wh.secret, body, ts);

  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  let status: number | undefined;
  let snippet: string | undefined;
  let success = false;
  try {
    const r = await fetch(wh.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-webhook-event": event,
        "x-webhook-signature": sig,
      },
      body,
      signal: ctl.signal,
    });
    status = r.status;
    snippet = (await r.text()).slice(0, 500);
    success = r.ok;
  } catch (e: any) {
    snippet = String(e?.message || e).slice(0, 500);
  } finally {
    clearTimeout(t);
  }
  await recordDelivery(wh.id, event, payload, status, snippet, success);
}

export async function dispatch(event: string, payload: unknown, userId?: string | null): Promise<void> {
  if (!hasDb()) return;
  const hooks = await listWebhooks(userId);
  const targets = hooks.filter((h) => h.events.includes(event) || h.events.includes("*"));
  await Promise.all(targets.map((h) => deliverOne(h, event, payload).catch(() => {})));
}
