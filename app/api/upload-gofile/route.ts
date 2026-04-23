import { NextRequest, NextResponse } from "next/server";
import { uploadToGofile } from "@/lib/gofile";

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
  const { filename, content, folderId, token } = body || {};
  if (typeof filename !== "string" || typeof content !== "string") {
    return NextResponse.json({ error: "filename and content are required" }, { status: 400 });
  }

  const t =
    typeof token === "string" && token
      ? token
      : process.env.GOFILE_TOKEN || undefined;
  const f =
    typeof folderId === "string" && folderId
      ? folderId
      : process.env.GOFILE_FOLDER_ID || undefined;

  const res = await uploadToGofile(filename, content, { token: t, folderId: f });
  return NextResponse.json(res);
}
