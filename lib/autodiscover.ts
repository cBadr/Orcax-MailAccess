import { promises as dns } from "dns";

export interface MailHost {
  host: string;
  port: number;
  secure: boolean; // true = implicit TLS, false = STARTTLS or plain
}

export interface MailConfig {
  imap: MailHost[];
  smtp: MailHost[];
  source: string;
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

function parseAutoconfig(xml: string): MailConfig | null {
  const imap: MailHost[] = [];
  const smtp: MailHost[] = [];
  const serverRe = /<incomingServer\b[^>]*type="(imap|pop3)"[^>]*>([\s\S]*?)<\/incomingServer>|<outgoingServer\b[^>]*type="smtp"[^>]*>([\s\S]*?)<\/outgoingServer>/gi;
  let m: RegExpExecArray | null;
  while ((m = serverRe.exec(xml))) {
    const body = m[2] || m[3] || "";
    const type = m[1] || "smtp";
    const host = (body.match(/<hostname>([^<]+)<\/hostname>/i) || [])[1];
    const port = parseInt((body.match(/<port>([^<]+)<\/port>/i) || [])[1] || "0", 10);
    const sock = ((body.match(/<socketType>([^<]+)<\/socketType>/i) || [])[1] || "").toUpperCase();
    if (!host || !port) continue;
    const secure = sock === "SSL";
    const entry = { host, port, secure };
    if (type === "imap") imap.push(entry);
    else if (type === "smtp") smtp.push(entry);
  }
  if (!imap.length && !smtp.length) return null;
  return { imap, smtp, source: "autoconfig" };
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
    // Use the MX base domain to guess common names.
    const parts = base.split(".");
    const apex = parts.slice(-2).join(".");
    const candidates = new Set([base, `imap.${apex}`, `mail.${apex}`, apex]);
    const imap: MailHost[] = [];
    const smtp: MailHost[] = [];
    for (const host of candidates) {
      imap.push({ host, port: 993, secure: true });
      smtp.push({ host, port: 465, secure: true });
      smtp.push({ host, port: 587, secure: false });
    }
    return { imap, smtp, source: "mx" };
  } catch {
    return null;
  }
}

function guessCommon(domain: string): MailConfig {
  const imap: MailHost[] = [
    { host: `imap.${domain}`, port: 993, secure: true },
    { host: `mail.${domain}`, port: 993, secure: true },
    { host: domain, port: 993, secure: true },
  ];
  const smtp: MailHost[] = [
    { host: `smtp.${domain}`, port: 465, secure: true },
    { host: `smtp.${domain}`, port: 587, secure: false },
    { host: `mail.${domain}`, port: 465, secure: true },
    { host: `mail.${domain}`, port: 587, secure: false },
  ];
  return { imap, smtp, source: "guess" };
}

// Known providers — saves autodiscovery round trips for common free mail hosts.
const KNOWN: Record<string, MailConfig> = {
  "gmail.com": {
    imap: [{ host: "imap.gmail.com", port: 993, secure: true }],
    smtp: [{ host: "smtp.gmail.com", port: 465, secure: true }],
    source: "known",
  },
  "googlemail.com": {
    imap: [{ host: "imap.gmail.com", port: 993, secure: true }],
    smtp: [{ host: "smtp.gmail.com", port: 465, secure: true }],
    source: "known",
  },
  "outlook.com": {
    imap: [{ host: "outlook.office365.com", port: 993, secure: true }],
    smtp: [{ host: "smtp.office365.com", port: 587, secure: false }],
    source: "known",
  },
  "hotmail.com": {
    imap: [{ host: "outlook.office365.com", port: 993, secure: true }],
    smtp: [{ host: "smtp.office365.com", port: 587, secure: false }],
    source: "known",
  },
  "live.com": {
    imap: [{ host: "outlook.office365.com", port: 993, secure: true }],
    smtp: [{ host: "smtp.office365.com", port: 587, secure: false }],
    source: "known",
  },
  "yahoo.com": {
    imap: [{ host: "imap.mail.yahoo.com", port: 993, secure: true }],
    smtp: [{ host: "smtp.mail.yahoo.com", port: 465, secure: true }],
    source: "known",
  },
  "aol.com": {
    imap: [{ host: "imap.aol.com", port: 993, secure: true }],
    smtp: [{ host: "smtp.aol.com", port: 465, secure: true }],
    source: "known",
  },
  "icloud.com": {
    imap: [{ host: "imap.mail.me.com", port: 993, secure: true }],
    smtp: [{ host: "smtp.mail.me.com", port: 587, secure: false }],
    source: "known",
  },
  "me.com": {
    imap: [{ host: "imap.mail.me.com", port: 993, secure: true }],
    smtp: [{ host: "smtp.mail.me.com", port: 587, secure: false }],
    source: "known",
  },
};

export async function discover(email: string): Promise<MailConfig> {
  const domain = domainOf(email);
  const now = Date.now();

  const hit = cache.get(domain);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.config;

  if (KNOWN[domain]) {
    cache.set(domain, { config: KNOWN[domain], at: now });
    return KNOWN[domain];
  }

  const auto = await tryThunderbirdAutoconfig(domain);
  if (auto) {
    cache.set(domain, { config: auto, at: now });
    return auto;
  }

  const mx = await tryMx(domain);
  const guess = guessCommon(domain);
  const merged: MailConfig = mx
    ? { imap: [...mx.imap, ...guess.imap], smtp: [...mx.smtp, ...guess.smtp], source: mx.source }
    : guess;

  // Dedupe.
  const seen = new Set<string>();
  const dedupe = (list: MailHost[]) =>
    list.filter((h) => {
      const k = `${h.host}:${h.port}:${h.secure}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  const final: MailConfig = { imap: dedupe(merged.imap), smtp: dedupe(merged.smtp), source: merged.source };
  cache.set(domain, { config: final, at: now });
  return final;
}
