import { NextResponse } from "next/server";
import { ensureMigrated, hasDb, sql } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    if (!hasDb()) return NextResponse.json({ enabled: false });
    await ensureMigrated();
    const s = sql();

    const [totals, byDomain, byCategory, byTld, avgLatency, byTlsMode, recent] = await Promise.all([
      s`SELECT COUNT(*)::int AS accounts,
               COUNT(*) FILTER (WHERE status='valid')::int AS valid,
               COUNT(*) FILTER (WHERE status='invalid')::int AS invalid
        FROM accounts`,
      s`SELECT domain, COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE status='valid')::int AS valid
        FROM accounts WHERE domain IS NOT NULL GROUP BY domain
        ORDER BY total DESC LIMIT 20`,
      s`SELECT error_category AS category, COUNT(*)::int AS n
        FROM checks WHERE error_category IS NOT NULL
        GROUP BY error_category ORDER BY n DESC LIMIT 15`,
      s`SELECT split_part(domain, '.', array_length(string_to_array(domain,'.'),1)) AS tld,
               COUNT(*)::int AS total
        FROM accounts WHERE domain IS NOT NULL
        GROUP BY tld ORDER BY total DESC LIMIT 15`,
      s`SELECT protocol, host, AVG(elapsed_ms)::int AS avg_ms, COUNT(*)::int AS n
        FROM checks WHERE elapsed_ms IS NOT NULL AND ok = true
        GROUP BY protocol, host HAVING COUNT(*) >= 3
        ORDER BY avg_ms ASC LIMIT 20`,
      s`SELECT tls_mode, protocol, COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE ok)::int AS ok
        FROM checks WHERE tls_mode IS NOT NULL
        GROUP BY tls_mode, protocol ORDER BY total DESC`,
      s`SELECT a.email, a.domain, a.status, a.created_at, b.name AS batch_name
        FROM accounts a LEFT JOIN batches b ON b.id = a.batch_id
        ORDER BY a.created_at DESC LIMIT 20`,
    ]);

    return NextResponse.json({
      enabled: true,
      totals: totals[0] || { accounts: 0, valid: 0, invalid: 0 },
      byDomain: byDomain ?? [],
      byCategory: byCategory ?? [],
      byTld: byTld ?? [],
      avgLatency: avgLatency ?? [],
      byTlsMode: byTlsMode ?? [],
      recent: recent ?? [],
    });
  } catch (e: any) {
    return NextResponse.json(
      { enabled: false, error: String(e?.message || e) },
      { status: 200 }, // stay 200 so the client renders the friendly message instead of erroring
    );
  }
}
