import { NextRequest, NextResponse } from "next/server";
import { batchJobSummary, jobStatus } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const jobId = searchParams.get("jobId");
  const batchId = searchParams.get("batchId");
  if (jobId) {
    const row = await jobStatus(jobId);
    if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(row);
  }
  if (batchId) {
    const s = await batchJobSummary(batchId);
    return NextResponse.json({ batchId, ...s });
  }
  return NextResponse.json({ error: "jobId or batchId required" }, { status: 400 });
}
