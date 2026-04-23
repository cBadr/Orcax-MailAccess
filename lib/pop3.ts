import net from "net";
import tls from "tls";
import type { MailHost } from "./autodiscover";
import { categorize, type CategorizedError } from "./errors";

export interface Pop3Result {
  ok: boolean;
  host?: string;
  port?: number;
  secure?: boolean;
  messageCount?: number;
  mailboxSizeBytes?: number;
  error?: CategorizedError;
}

interface Session {
  socket: net.Socket | tls.TLSSocket;
  buffer: string;
  queue: Array<(line: string) => void>;
}

function readResponse(s: Session, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const t = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      reject(new Error("pop3 response timeout"));
    }, timeoutMs);

    const tryDrain = () => {
      const idx = s.buffer.indexOf("\r\n");
      if (idx < 0) return false;
      const line = s.buffer.slice(0, idx);
      s.buffer = s.buffer.slice(idx + 2);
      resolved = true;
      clearTimeout(t);
      resolve(line);
      return true;
    };

    if (tryDrain()) return;
    s.queue.push(() => {
      if (!resolved) tryDrain();
    });
  });
}

function writeCmd(s: Session, cmd: string) {
  s.socket.write(cmd + "\r\n");
}

function openSocket(host: string, port: number, secure: boolean, timeoutMs: number): Promise<Session> {
  return new Promise((resolve, reject) => {
    const onError = (e: Error) => reject(e);
    const socket = secure
      ? tls.connect({ host, port, rejectUnauthorized: false, servername: host })
      : net.connect({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once("timeout", () => socket.destroy(new Error("connection timeout")));
    socket.once("error", onError);

    const session: Session = { socket, buffer: "", queue: [] };
    socket.on("data", (chunk: Buffer) => {
      session.buffer += chunk.toString("utf8");
      const cbs = session.queue.splice(0);
      for (const cb of cbs) cb(session.buffer);
    });

    const onReady = () => {
      socket.off("error", onError);
      resolve(session);
    };
    if (secure) socket.once("secureConnect", onReady);
    else socket.once("connect", onReady);
  });
}

async function closeQuiet(s: Session) {
  try {
    writeCmd(s, "QUIT");
  } catch {}
  try {
    s.socket.destroy();
  } catch {}
}

export async function verifyPop3(
  email: string,
  password: string,
  hosts: MailHost[],
  timeoutMs = 10000,
): Promise<Pop3Result> {
  let lastErr: CategorizedError = categorize("no hosts");
  for (const h of hosts) {
    let s: Session | null = null;
    try {
      s = await openSocket(h.host, h.port, h.secure, timeoutMs);
      const greeting = await readResponse(s, timeoutMs);
      if (!greeting.startsWith("+OK")) throw new Error(`bad greeting: ${greeting}`);

      // Try STLS if not already secure.
      if (!h.secure) {
        writeCmd(s, "STLS");
        const r = await readResponse(s, timeoutMs);
        if (r.startsWith("+OK")) {
          // Upgrade socket.
          const plain = s.socket as net.Socket;
          const upgraded: tls.TLSSocket = await new Promise((resolve, reject) => {
            const u = tls.connect({ socket: plain, rejectUnauthorized: false, servername: h.host });
            u.once("secureConnect", () => resolve(u));
            u.once("error", reject);
          });
          s = { socket: upgraded, buffer: "", queue: [] };
          upgraded.on("data", (chunk: Buffer) => {
            s!.buffer += chunk.toString("utf8");
            const cbs = s!.queue.splice(0);
            for (const cb of cbs) cb(s!.buffer);
          });
        }
      }

      writeCmd(s, `USER ${email}`);
      const ur = await readResponse(s, timeoutMs);
      if (!ur.startsWith("+OK")) throw new Error(ur);

      writeCmd(s, `PASS ${password}`);
      const pr = await readResponse(s, timeoutMs);
      if (!pr.startsWith("+OK")) throw new Error(pr);

      writeCmd(s, "STAT");
      const stat = await readResponse(s, timeoutMs);
      let count = 0;
      let size = 0;
      const m = /\+OK\s+(\d+)\s+(\d+)/.exec(stat);
      if (m) {
        count = parseInt(m[1], 10);
        size = parseInt(m[2], 10);
      }

      await closeQuiet(s);
      return { ok: true, host: h.host, port: h.port, secure: h.secure, messageCount: count, mailboxSizeBytes: size };
    } catch (e) {
      if (s) await closeQuiet(s);
      const cat = categorize(e);
      lastErr = cat;
      if (cat.category === "auth_failed" || cat.category === "2fa_required") {
        return { ok: false, host: h.host, port: h.port, secure: h.secure, error: cat };
      }
    }
  }
  return { ok: false, error: lastErr };
}
