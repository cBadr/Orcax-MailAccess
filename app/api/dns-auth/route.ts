import { NextRequest, NextResponse } from "next/server";
import { checkDnsAuth } from "@/lib/dns-auth";
import { audit, clientMeta } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const { domain, email, selectors } = body || {};
  const target = (typeof domain === "string" && domain) || (typeof email === "string" && email.split("@")[1]) || "";
  if (!target) return NextResponse.json({ error: "domain or email is required" }, { status: 400 });

  const meta = clientMeta(req);
  await audit({ action: "dns.check", target, ...meta });

  const result = await checkDnsAuth(target.toLowerCase(), Array.isArray(selectors) ? selectors : undefined);
  return NextResponse.json(result);
}
