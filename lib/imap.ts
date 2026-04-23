import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { MailHost } from "./autodiscover";

export interface ImapResult {
  ok: boolean;
  host?: string;
  port?: number;
  secure?: boolean;
  error?: string;
}

export interface Contact {
  name?: string;
  email: string;
  source: string; // header field that produced it
  folder: string;
}

export interface ExtractResult {
  ok: boolean;
  host?: string;
  contacts: Contact[];
  addresses: string[]; // unique lowercase emails
  folders: string[];
  messagesScanned: number;
  error?: string;
}

const EMAIL_RE = /([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/g;

function silentLogger() {
  const noop = () => {};
  return { debug: noop, info: noop, warn: noop, error: noop } as any;
}

async function open(email: string, password: string, h: MailHost, timeoutMs: number) {
  const client = new ImapFlow({
    host: h.host,
    port: h.port,
    secure: h.secure,
    auth: { user: email, pass: password },
    logger: silentLogger(),
    tls: { rejectUnauthorized: false },
    socketTimeout: timeoutMs,
  });
  await client.connect();
  return client;
}

export async function verifyImap(
  email: string,
  password: string,
  hosts: MailHost[],
  timeoutMs = 8000,
): Promise<ImapResult> {
  let lastErr = "no hosts";
  for (const h of hosts) {
    try {
      const client = await open(email, password, h, timeoutMs);
      await client.logout().catch(() => {});
      return { ok: true, host: h.host, port: h.port, secure: h.secure };
    } catch (e: any) {
      const msg = String(e?.message || e);
      lastErr = msg;
      if (/auth|invalid credentials|login|NO|BAD/i.test(msg) && !/timeout|ENOTFOUND|ECONN/i.test(msg)) {
        return { ok: false, host: h.host, port: h.port, secure: h.secure, error: msg };
      }
    }
  }
  return { ok: false, error: lastErr };
}

function addContact(
  seen: Map<string, Contact>,
  name: string | undefined,
  addr: string,
  source: string,
  folder: string,
) {
  const key = addr.toLowerCase().trim();
  if (!key || !EMAIL_RE.test(key)) return;
  const existing = seen.get(key);
  if (existing) {
    if (!existing.name && name) existing.name = name;
    return;
  }
  seen.set(key, { name: name?.trim() || undefined, email: key, source, folder });
}

export async function extractContacts(
  email: string,
  password: string,
  hosts: MailHost[],
  opts: {
    maxMessages?: number;
    maxBodyScan?: number;
    timeoutMs?: number;
  } = {},
): Promise<ExtractResult> {
  const maxMessages = opts.maxMessages ?? 500;
  const maxBodyScan = opts.maxBodyScan ?? 100;
  const timeoutMs = opts.timeoutMs ?? 8000;

  let client: ImapFlow | null = null;
  let chosen: MailHost | null = null;
  let lastErr = "no hosts";

  for (const h of hosts) {
    try {
      client = await open(email, password, h, timeoutMs);
      chosen = h;
      break;
    } catch (e: any) {
      lastErr = String(e?.message || e);
    }
  }
  if (!client || !chosen) {
    return { ok: false, contacts: [], addresses: [], folders: [], messagesScanned: 0, error: lastErr };
  }

  const contacts = new Map<string, Contact>();
  const folders: string[] = [];
  let scanned = 0;

  try {
    const list = await client.list();
    for (const mailbox of list) {
      if ((mailbox.flags as any)?.has?.("\\Noselect")) continue;
      folders.push(mailbox.path);
    }

    outer: for (const path of folders) {
      let lock;
      try {
        lock = await client.getMailboxLock(path);
      } catch {
        continue;
      }
      try {
        const status = await client.status(path, { messages: true }).catch(() => ({ messages: 0 }));
        const count = status.messages || 0;
        if (!count) continue;

        // Fetch newest messages first — seq range with * and walk backwards.
        const remaining = Math.max(0, maxMessages - scanned);
        if (!remaining) break;
        const take = Math.min(count, remaining);
        const from = Math.max(1, count - take + 1);
        const range = `${from}:${count}`;

        const bodyBudget = Math.min(take, Math.max(0, maxBodyScan - (scanned - contacts.size)));

        let i = 0;
        for await (const msg of client.fetch(range, { envelope: true, source: bodyBudget > 0 })) {
          scanned++;
          i++;

          const env = msg.envelope;
          if (env) {
            const fields: Array<[string, any[] | undefined]> = [
              ["from", env.from],
              ["to", env.to],
              ["cc", env.cc],
              ["bcc", env.bcc],
              ["reply-to", env.replyTo],
              ["sender", env.sender],
            ];
            for (const [src, list] of fields) {
              if (!list) continue;
              for (const a of list) {
                const addr = `${a.mailbox || ""}@${a.host || ""}`;
                addContact(contacts, a.name, addr, src, path);
              }
            }
          }

          if (msg.source && i <= bodyBudget) {
            try {
              const parsed = await simpleParser(msg.source);
              const headerFields: Array<[string, any]> = [
                ["from", parsed.from],
                ["to", parsed.to],
                ["cc", parsed.cc],
                ["bcc", parsed.bcc],
                ["reply-to", parsed.replyTo],
              ];
              for (const [src, v] of headerFields) {
                const arr = Array.isArray(v) ? v : v ? [v] : [];
                for (const group of arr) {
                  const addrs = (group as any)?.value || [];
                  for (const a of addrs) {
                    if (a.address) addContact(contacts, a.name, a.address, src, path);
                  }
                }
              }
              const text = (parsed.text || "") + "\n" + (parsed.html || "");
              const matches = text.match(EMAIL_RE);
              if (matches) for (const m of matches) addContact(contacts, undefined, m, "body", path);
            } catch {
              // Ignore parse errors.
            }
          }

          if (scanned >= maxMessages) break outer;
        }
      } finally {
        lock.release();
      }
    }
  } catch (e: any) {
    lastErr = String(e?.message || e);
  } finally {
    await client.logout().catch(() => {});
  }

  const list = [...contacts.values()];
  return {
    ok: true,
    host: chosen.host,
    contacts: list,
    addresses: list.map((c) => c.email),
    folders,
    messagesScanned: scanned,
  };
}
