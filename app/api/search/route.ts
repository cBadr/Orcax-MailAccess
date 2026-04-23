import { NextRequest, NextResponse } from "next/server";
import { ensureMigrated, hasDb, sql } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    if (!hasDb()) return NextResponse.json({ enabled: false, results: [] });
    await ensureMigrated();
    const { searchParams } = new URL(req.url);
    const q = searchParams.get("q")?.trim();
    const limit = Math.min(parseInt(searchParams.get("limit") || "50", 10) || 50, 500);
    if (!q) return NextResponse.json({ enabled: true, results: [] });
    const s = sql();
    const rows = await s`
      SELECT id, account_id, folder, subject, from_addr, to_addrs, sent_at,
             ts_headline('simple', coalesce(body,''), plainto_tsquery('simple', ${q}), 'MaxFragments=2,MinWords=5,MaxWords=15') AS snippet,
             ts_rank(tsv, plainto_tsquery('simple', ${q})) AS rank
      FROM messages
      WHERE tsv @@ plainto_tsquery('simple', ${q})
      ORDER BY rank DESC
      LIMIT ${limit}
    `;
    return NextResponse.json({ enabled: true, results: rows });
  } catch (e: any) {
    return NextResponse.json({ enabled: false, results: [], error: String(e?.message || e) });
  }
}
