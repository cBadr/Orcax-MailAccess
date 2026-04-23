import { NextRequest, NextResponse } from "next/server";
import { discover } from "@/lib/autodiscover";
import { extractContacts } from "@/lib/imap";

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
  const { email, password, maxMessages, maxBodyScan } = body || {};
  if (typeof email !== "string" || typeof password !== "string") {
    return NextResponse.json({ error: "email and password are required" }, { status: 400 });
  }

  const config = await discover(email);
  const result = await extractContacts(email, password, config.imap, {
    maxMessages: typeof maxMessages === "number" ? maxMessages : 500,
    maxBodyScan: typeof maxBodyScan === "number" ? maxBodyScan : 100,
  });

  return NextResponse.json({ email, ...result });
}
