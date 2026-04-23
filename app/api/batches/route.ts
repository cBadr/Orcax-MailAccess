import { NextRequest, NextResponse } from "next/server";
import { ensureMigrated, hasDb, sql } from "@/lib/db";
import { createBatch } from "@/lib/store";
import { audit, clientMeta } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    if (!hasDb()) return NextResponse.json({ enabled: false, batches: [] });
    await ensureMigrated();
    const s = sql();
    const rows = await s`
      SELECT id, name, note, status, total, valid, invalid, errored, created_at, finished_at
      FROM batches ORDER BY created_at DESC LIMIT 100
    `;
    return NextResponse.json({ enabled: true, batches: rows });
  } catch (e: any) {
    return NextResponse.json({ enabled: false, batches: [], error: String(e?.message || e) });
  }
}

export async function POST(req: NextRequest) {
  try {
    if (!hasDb()) return NextResponse.json({ enabled: false, error: "DATABASE_URL not configured" }, { status: 400 });
    let body: any = {};
    try {
      body = await req.json();
    } catch {}
    const id = await createBatch(body?.name, body?.note);
    const meta = clientMeta(req);
    await audit({ action: "batch.create", target: id || undefined, details: { name: body?.name, note: body?.note }, ...meta });
    return NextResponse.json({ id });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
