import { promises as dns } from "dns";

export type TlsMode = "implicit" | "starttls" | "plain";

export interface MailHost {
  host: string;
  port: number;
  secure: boolean; // kept for back-compat; true iff tlsMode === "implicit"
  tlsMode: TlsMode;
}

export interface MailConfig {
  imap: MailHost[];
  pop3: MailHost[];
  smtp: MailHost[];
  source: string;
}

function makeHost(host: string, port: number, tlsMode: TlsMode): MailHost {
  return { host, port, tlsMode, secure: tlsMode === "implicit" };
}

// In-process cache keyed by domain.
const cache = new Map<string, { config: MailConfig; at: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000;

function domainOf(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1).toLowerCase();
}

async function fetchWithTimeout(url: string, ms = 4000): Promise<Response | null> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    const r = await fetch(url, { signal: ctl.signal, redirect: "follow" });
    clearTimeout(t);
    if (!r.ok) return null;
    return r;
  } catch {
    return null;
  }
}

function socketTypeToTls(sock: string): TlsMode {
  const s = sock.toUpperCase();
  if (s === "SSL") return "implicit";
  if (s === "STARTTLS") return "starttls";
  return "plain";
}

function parseAutoconfig(xml: string): MailConfig | null {
  const imap: MailHost[] = [];
  const pop3: MailHost[] = [];
  const smtp: MailHost[] = [];
  const serverRe = /<incomingServer\b[^>]*type="(imap|pop3)"[^>]*>([\s\S]*?)<\/incomingServer>|<outgoingServer\b[^>]*type="smtp"[^>]*>([\s\S]*?)<\/outgoingServer>/gi;
  let m: RegExpExecArray | null;
  while ((m = serverRe.exec(xml))) {
    const body = m[2] || m[3] || "";
    const type = m[1] || "smtp";
    const host = (body.match(/<hostname>([^<]+)<\/hostname>/i) || [])[1];
    const port = parseInt((body.match(/<port>([^<]+)<\/port>/i) || [])[1] || "0", 10);
    const sock = ((body.match(/<socketType>([^<]+)<\/socketType>/i) || [])[1] || "");
    if (!host || !port) continue;
    const entry = makeHost(host, port, socketTypeToTls(sock));
    if (type === "imap") imap.push(entry);
    else if (type === "pop3") pop3.push(entry);
    else if (type === "smtp") smtp.push(entry);
  }
  if (!imap.length && !pop3.length && !smtp.length) return null;
  return { imap, pop3, smtp, source: "autoconfig" };
}

async function tryThunderbirdAutoconfig(domain: string): Promise<MailConfig | null> {
  const urls = [
    `https://autoconfig.${domain}/mail/config-v1.1.xml`,
    `https://autoconfig.thunderbird.net/v1.1/${domain}`,
  ];
  for (const u of urls) {
    const r = await fetchWithTimeout(u);
    if (!r) continue;
    const xml = await r.text();
    const cfg = parseAutoconfig(xml);
    if (cfg) return cfg;
  }
  return null;
}

async function tryMx(domain: string): Promise<MailConfig | null> {
  try {
    const mx = await dns.resolveMx(domain);
    if (!mx.length) return null;
    mx.sort((a, b) => a.priority - b.priority);
    const base = mx[0].exchange.replace(/\.$/, "");
    const parts = base.split(".");
    const apex = parts.slice(-2).join(".");
    const candidates = new Set([base, `imap.${apex}`, `mail.${apex}`, apex]);
    return buildCandidates([...candidates], "mx");
  } catch {
    return null;
  }
}

async function trySrv(domain: string): Promise<Partial<MailConfig> | null> {
  const out: Partial<MailConfig> = { imap: [], pop3: [], smtp: [], source: "srv" };
  const records: Array<[string, "imap" | "pop3" | "smtp", TlsMode]> = [
    [`_imaps._tcp.${domain}`, "imap", "implicit"],
    [`_imap._tcp.${domain}`, "imap", "starttls"],
    [`_pop3s._tcp.${domain}`, "pop3", "implicit"],
    [`_pop3._tcp.${domain}`, "pop3", "starttls"],
    [`_submissions._tcp.${domain}`, "smtp", "implicit"],
    [`_submission._tcp.${domain}`, "smtp", "starttls"],
  ];
  let found = false;
  await Promise.all(
    records.map(async ([rec, proto, tls]) => {
      try {
        const r = await dns.resolveSrv(rec);
        for (const e of r) {
          const h = e.name.replace(/\.$/, "");
          (out as any)[proto].push(makeHost(h, e.port, tls));
          found = true;
        }
      } catch {
        // ignore
      }
    }),
  );
  return found ? out : null;
}

function buildCandidates(hosts: string[], source: string): MailConfig {
  const imap: MailHost[] = [];
  const pop3: MailHost[] = [];
  const smtp: MailHost[] = [];
  for (const h of hosts) {
    imap.push(makeHost(h, 993, "implicit"));
    imap.push(makeHost(h, 143, "starttls"));
    pop3.push(makeHost(h, 995, "implicit"));
    pop3.push(makeHost(h, 110, "starttls"));
    smtp.push(makeHost(h, 465, "implicit"));
    smtp.push(makeHost(h, 587, "starttls"));
    smtp.push(makeHost(h, 25, "starttls"));
  }
  return { imap, pop3, smtp, source };
}

function guessCommon(domain: string): MailConfig {
  return buildCandidates([`imap.${domain}`, `mail.${domain}`, `pop.${domain}`, `smtp.${domain}`, domain], "guess");
}

const KNOWN: Record<string, MailConfig> = {
  "gmail.com": {
    imap: [makeHost("imap.gmail.com", 993, "implicit")],
    pop3: [makeHost("pop.gmail.com", 995, "implicit")],
    smtp: [makeHost("smtp.gmail.com", 465, "implicit"), makeHost("smtp.gmail.com", 587, "starttls")],
    source: "known",
  },
  "googlemail.com": {
    imap: [makeHost("imap.gmail.com", 993, "implicit")],
    pop3: [makeHost("pop.gmail.com", 995, "implicit")],
    smtp: [makeHost("smtp.gmail.com", 465, "implicit"), makeHost("smtp.gmail.com", 587, "starttls")],
    source: "known",
  },
  "outlook.com": {
    imap: [makeHost("outlook.office365.com", 993, "implicit")],
    pop3: [makeHost("outlook.office365.com", 995, "implicit")],
    smtp: [makeHost("smtp.office365.com", 587, "starttls")],
    source: "known",
  },
  "hotmail.com": {
    imap: [makeHost("outlook.office365.com", 993, "implicit")],
    pop3: [makeHost("outlook.office365.com", 995, "implicit")],
    smtp: [makeHost("smtp.office365.com", 587, "starttls")],
    source: "known",
  },
  "live.com": {
    imap: [makeHost("outlook.office365.com", 993, "implicit")],
    pop3: [makeHost("outlook.office365.com", 995, "implicit")],
    smtp: [makeHost("smtp.office365.com", 587, "starttls")],
    source: "known",
  },
  "yahoo.com": {
    imap: [makeHost("imap.mail.yahoo.com", 993, "implicit")],
    pop3: [makeHost("pop.mail.yahoo.com", 995, "implicit")],
    smtp: [makeHost("smtp.mail.yahoo.com", 465, "implicit")],
    source: "known",
  },
  "aol.com": {
    imap: [makeHost("imap.aol.com", 993, "implicit")],
    pop3: [makeHost("pop.aol.com", 995, "implicit")],
    smtp: [makeHost("smtp.aol.com", 465, "implicit")],
    source: "known",
  },
  "icloud.com": {
    imap: [makeHost("imap.mail.me.com", 993, "implicit")],
    pop3: [],
    smtp: [makeHost("smtp.mail.me.com", 587, "starttls")],
    source: "known",
  },
  "me.com": {
    imap: [makeHost("imap.mail.me.com", 993, "implicit")],
    pop3: [],
    smtp: [makeHost("smtp.mail.me.com", 587, "starttls")],
    source: "known",
  },
};

function dedupe(list: MailHost[]): MailHost[] {
  const seen = new Set<string>();
  return list.filter((h) => {
    const k = `${h.host}:${h.port}:${h.tlsMode}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function merge(...configs: Array<Partial<MailConfig> | null | undefined>): MailConfig {
  const imap: MailHost[] = [];
  const pop3: MailHost[] = [];
  const smtp: MailHost[] = [];
  let source = "guess";
  for (const c of configs) {
    if (!c) continue;
    if (c.imap) imap.push(...c.imap);
    if (c.pop3) pop3.push(...c.pop3);
    if (c.smtp) smtp.push(...c.smtp);
    if (c.source) source = c.source;
  }
  return { imap: dedupe(imap), pop3: dedupe(pop3), smtp: dedupe(smtp), source };
}

export async function discover(email: string): Promise<MailConfig> {
  const domain = domainOf(email);
  const now = Date.now();

  const hit = cache.get(domain);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.config;

  if (KNOWN[domain]) {
    cache.set(domain, { config: KNOWN[domain], at: now });
    return KNOWN[domain];
  }

  const [auto, srv, mx] = await Promise.all([tryThunderbirdAutoconfig(domain), trySrv(domain), tryMx(domain)]);
  if (auto) {
    const merged = merge(auto, srv, mx, guessCommon(domain));
    merged.source = "autoconfig";
    cache.set(domain, { config: merged, at: now });
    return merged;
  }

  const guess = guessCommon(domain);
  const final = merge(srv, mx, guess);
  cache.set(domain, { config: final, at: now });
  return final;
}
