import { NextRequest, NextResponse } from "next/server";
import { createWebhook, deleteWebhook, listWebhooks } from "@/lib/webhooks";
import { hasDb } from "@/lib/db";
import { audit, clientMeta } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!hasDb()) return NextResponse.json({ enabled: false, webhooks: [] });
  const rows = await listWebhooks();
  return NextResponse.json({ enabled: true, webhooks: rows });
}

export async function POST(req: NextRequest) {
  if (!hasDb()) return NextResponse.json({ error: "DATABASE_URL not configured" }, { status: 400 });
  const body = await req.json().catch(() => ({}));
  const { url, events } = body || {};
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return NextResponse.json({ error: "url required" }, { status: 400 });
  const evs = Array.isArray(events) && events.length ? events : ["check.completed", "send.completed", "extract.completed"];
  const wh = await createWebhook(url, evs);
  const meta = clientMeta(req);
  await audit({ action: "webhook.create", target: url, details: { events: evs }, ...meta });
  return NextResponse.json(wh);
}

export async function DELETE(req: NextRequest) {
  if (!hasDb()) return NextResponse.json({ error: "DATABASE_URL not configured" }, { status: 400 });
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await deleteWebhook(id);
  const meta = clientMeta(req);
  await audit({ action: "webhook.delete", target: id, ...meta });
  return NextResponse.json({ ok: true });
}
