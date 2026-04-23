import { NextRequest } from "next/server";
import { subscribe } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const channel = searchParams.get("channel") || "*";

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        try {
          controller.enqueue(encoder.encode(line));
        } catch {
          // closed
        }
      };

      send("ready", { channel, at: new Date().toISOString() });
      const unsub = subscribe(channel, send);

      // Heartbeat so intermediaries don't drop idle streams.
      const hb = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: hb ${Date.now()}\n\n`));
        } catch {
          clearInterval(hb);
        }
      }, 15000);

      const abort = () => {
        clearInterval(hb);
        unsub();
        try {
          controller.close();
        } catch {}
      };
      req.signal.addEventListener("abort", abort);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
