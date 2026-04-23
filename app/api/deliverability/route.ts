import { NextRequest, NextResponse } from "next/server";
import { fetchMailTesterReport, glockAppsFetch, glockAppsStart, mailTesterTarget } from "@/lib/deliverability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST { provider: "mail-tester", address } -> target
// POST { provider: "mail-tester", testId, fetch: true, apiToken? } -> report
// POST { provider: "glockapps", action: "start" }
// POST { provider: "glockapps", action: "fetch", testId }
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { provider } = body || {};

  if (provider === "mail-tester") {
    if (body.fetch && body.testId) {
      const token = typeof body.apiToken === "string" ? body.apiToken : process.env.MAILTESTER_TOKEN;
      return NextResponse.json(await fetchMailTesterReport(body.testId, token));
    }
    const addr = body.address;
    if (typeof addr !== "string") return NextResponse.json({ error: "address required" }, { status: 400 });
    return NextResponse.json(mailTesterTarget(addr));
  }

  if (provider === "glockapps") {
    const apiKey = typeof body.apiKey === "string" ? body.apiKey : process.env.GLOCKAPPS_KEY;
    if (!apiKey) return NextResponse.json({ error: "GlockApps API key required" }, { status: 400 });
    if (body.action === "start") return NextResponse.json(await glockAppsStart(apiKey));
    if (body.action === "fetch" && body.testId) return NextResponse.json(await glockAppsFetch(apiKey, body.testId));
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  }

  return NextResponse.json({ error: "unknown provider" }, { status: 400 });
}
