import { NextRequest, NextResponse } from "next/server";
import { discover } from "@/lib/autodiscover";
import { extractContacts } from "@/lib/imap";
import { extractCardDav } from "@/lib/carddav";
import { audit, clientMeta } from "@/lib/audit";
import { dispatch } from "@/lib/webhooks";
import { publish } from "@/lib/events";
import { ensureAccount, recordContacts } from "@/lib/store";

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
  const { email, password, maxMessages, maxBodyScan, includeCardDav, batchId } = body || {};
  if (typeof email !== "string" || typeof password !== "string") {
    return NextResponse.json({ error: "email and password are required" }, { status: 400 });
  }

  const meta = clientMeta(req);
  await audit({ action: "extract.start", target: email, details: { maxMessages, includeCardDav: !!includeCardDav }, ...meta });

  const config = await discover(email);

  const imapPromise = extractContacts(email, password, config.imap, {
    maxMessages: typeof maxMessages === "number" ? maxMessages : 500,
    maxBodyScan: typeof maxBodyScan === "number" ? maxBodyScan : 100,
  });
  const cardPromise = includeCardDav
    ? extractCardDav(email, password).catch((e: any) => ({ ok: false, error: String(e?.message || e), contacts: [], addressBooks: [] }))
    : Promise.resolve(null);

  const [imapRes, cardRes] = await Promise.all([imapPromise, cardPromise]);

  // Merge contacts from both sources, deduped by email.
  const seen = new Map<string, any>();
  for (const c of imapRes.contacts) {
    const k = c.email;
    if (!seen.has(k)) seen.set(k, c);
  }
  if (cardRes?.contacts) {
    for (const c of cardRes.contacts) {
      const existing = seen.get(c.email);
      if (!existing) seen.set(c.email, c);
      else {
        if (!existing.name && c.name) existing.name = c.name;
        if (!existing.phone && c.phone) existing.phone = c.phone;
        if (!existing.org && c.org) existing.org = c.org;
      }
    }
  }
  const merged = [...seen.values()];

  // Persist if a batch is attached.
  if (batchId) {
    const accountId = await ensureAccount(batchId, email, password);
    if (accountId) await recordContacts(accountId, merged);
  }

  const response = {
    email,
    ok: imapRes.ok || Boolean(cardRes?.ok),
    imap: { ok: imapRes.ok, host: imapRes.host, folders: imapRes.folders, messagesScanned: imapRes.messagesScanned, error: imapRes.error },
    carddav: cardRes ? { ok: cardRes.ok, addressBooks: cardRes.addressBooks, error: cardRes.error, base: cardRes.base } : null,
    contacts: merged,
    addresses: merged.map((c) => c.email),
    counts: { total: merged.length, imap: imapRes.contacts.length, carddav: cardRes?.contacts?.length || 0 },
  };

  publish(batchId || "*", "extract.completed", { ...response, batchId });
  await dispatch("extract.completed", { ...response, batchId }).catch(() => {});
  await audit({ action: "extract.done", target: email, details: { contacts: merged.length }, ...meta });

  return NextResponse.json(response);
}
