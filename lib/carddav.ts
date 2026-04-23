// Minimal CardDAV crawler: discovers the user's address-book collection(s) and
// parses vCard entries into {name, email, phone, org}.

export interface CardDavContact {
  name?: string;
  email: string;
  phone?: string;
  org?: string;
  source: "carddav";
  folder: string;
}

export interface CardDavResult {
  ok: boolean;
  base?: string;
  principal?: string;
  addressBooks: string[];
  contacts: CardDavContact[];
  error?: string;
}

const DOMAIN_TO_CARDDAV: Record<string, string> = {
  "gmail.com": "https://www.googleapis.com/carddav/v1/principals/",
  "googlemail.com": "https://www.googleapis.com/carddav/v1/principals/",
  "icloud.com": "https://contacts.icloud.com",
  "me.com": "https://contacts.icloud.com",
  "yahoo.com": "https://carddav.address.yahoo.com",
  "fastmail.com": "https://carddav.fastmail.com",
  "fastmail.fm": "https://carddav.fastmail.com",
};

function basicAuth(email: string, password: string) {
  return "Basic " + Buffer.from(`${email}:${password}`, "utf8").toString("base64");
}

async function propfind(url: string, auth: string, depth: string, body: string, timeoutMs: number): Promise<{ status: number; text: string }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "PROPFIND",
      headers: { authorization: auth, depth, "content-type": 'application/xml; charset="utf-8"' },
      body,
      signal: ctl.signal,
    });
    return { status: r.status, text: await r.text() };
  } finally {
    clearTimeout(t);
  }
}

async function report(url: string, auth: string, body: string, timeoutMs: number): Promise<{ status: number; text: string }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "REPORT",
      headers: { authorization: auth, depth: "1", "content-type": 'application/xml; charset="utf-8"' },
      body,
      signal: ctl.signal,
    });
    return { status: r.status, text: await r.text() };
  } finally {
    clearTimeout(t);
  }
}

function extract(xml: string, re: RegExp): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

function parseVcard(text: string, folder: string): CardDavContact[] {
  const out: CardDavContact[] = [];
  const cards = text.split(/BEGIN:VCARD/i).slice(1);
  for (const card of cards) {
    const body = card.split(/END:VCARD/i)[0];
    if (!body) continue;
    const fn = /(?:^|\n)FN[^:]*:([^\r\n]+)/i.exec(body)?.[1];
    const org = /(?:^|\n)ORG[^:]*:([^\r\n]+)/i.exec(body)?.[1];
    const phone = /(?:^|\n)TEL[^:]*:([^\r\n]+)/i.exec(body)?.[1];
    const emailMatches = body.match(/(?:^|\n)EMAIL[^:]*:([^\r\n]+)/gi) || [];
    for (const raw of emailMatches) {
      const addr = raw.split(":").slice(1).join(":").trim().toLowerCase();
      if (!addr || !/^[^\s@]+@[^\s@]+$/.test(addr)) continue;
      out.push({
        name: fn?.trim(),
        email: addr,
        phone: phone?.trim(),
        org: org?.trim(),
        source: "carddav",
        folder,
      });
    }
  }
  return out;
}

export async function extractCardDav(
  email: string,
  password: string,
  opts: { base?: string; timeoutMs?: number } = {},
): Promise<CardDavResult> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const domain = email.split("@")[1]?.toLowerCase() || "";
  const auth = basicAuth(email, password);

  const bases = [
    opts.base,
    DOMAIN_TO_CARDDAV[domain],
    `https://carddav.${domain}`,
    `https://mail.${domain}`,
    `https://${domain}`,
  ].filter(Boolean) as string[];

  const propfindBody =
    `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/">` +
    `<d:prop><d:current-user-principal/><d:resourcetype/><d:displayname/></d:prop></d:propfind>`;

  let chosenBase: string | undefined;
  let principal: string | undefined;

  for (const base of bases) {
    try {
      // Discover via /.well-known/carddav first, then root.
      for (const path of ["/.well-known/carddav", "/"]) {
        const res = await propfind(base + path, auth, "0", propfindBody, timeoutMs).catch(() => null);
        if (!res) continue;
        if (res.status === 401 || res.status === 403) {
          return { ok: false, addressBooks: [], contacts: [], error: `auth failed at ${base}` };
        }
        const principals = extract(res.text, /<(?:[a-z0-9]+:)?current-user-principal[^>]*>\s*<(?:[a-z0-9]+:)?href[^>]*>([^<]+)<\/[a-z0-9]+:?href>\s*<\/[a-z0-9]+:?current-user-principal>/i);
        if (principals.length) {
          chosenBase = base;
          principal = new URL(principals[0], base).toString();
          break;
        }
      }
      if (chosenBase) break;
    } catch {
      // try next base
    }
  }

  if (!chosenBase || !principal) {
    return { ok: false, addressBooks: [], contacts: [], error: "no CardDAV endpoint discovered" };
  }

  // Find address-book-home-set.
  const homeBody =
    `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav">` +
    `<d:prop><c:addressbook-home-set/></d:prop></d:propfind>`;
  const homeRes = await propfind(principal, auth, "0", homeBody, timeoutMs).catch(() => null);
  if (!homeRes) return { ok: false, addressBooks: [], contacts: [], error: "home-set request failed" };
  const homes = extract(homeRes.text, /<(?:[a-z0-9]+:)?addressbook-home-set[^>]*>[\s\S]*?<(?:[a-z0-9]+:)?href[^>]*>([^<]+)<\/[a-z0-9]+:?href>/i);
  if (!homes.length) return { ok: false, addressBooks: [], contacts: [], error: "no address-book-home-set" };
  const homeUrl = new URL(homes[0], chosenBase).toString();

  // List address books under home-set.
  const listBody =
    `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav">` +
    `<d:prop><d:resourcetype/><d:displayname/></d:prop></d:propfind>`;
  const listRes = await propfind(homeUrl, auth, "1", listBody, timeoutMs).catch(() => null);
  if (!listRes) return { ok: false, addressBooks: [], contacts: [], error: "address-book list failed" };
  const bookRefs = extract(listRes.text, /<(?:[a-z0-9]+:)?response[^>]*>[\s\S]*?<(?:[a-z0-9]+:)?href[^>]*>([^<]+)<\/[a-z0-9]+:?href>[\s\S]*?<(?:[a-z0-9]+:)?addressbook\s*\/>/gi);
  const books = bookRefs.map((h) => new URL(h, chosenBase!).toString());

  // Fetch vCards from each.
  const contacts: CardDavContact[] = [];
  const reportBody =
    `<?xml version="1.0"?><c:addressbook-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav">` +
    `<d:prop><d:getetag/><c:address-data/></d:prop></c:addressbook-query>`;

  for (const book of books) {
    const rep = await report(book, auth, reportBody, timeoutMs).catch(() => null);
    if (!rep) continue;
    // address-data blocks contain the full vCard text.
    const blocks = rep.text.match(/<(?:[a-z0-9]+:)?address-data[^>]*>([\s\S]*?)<\/[a-z0-9]+:?address-data>/gi) || [];
    for (const b of blocks) {
      const body = b.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
      contacts.push(...parseVcard(body, book));
    }
  }

  return { ok: true, base: chosenBase, principal, addressBooks: books, contacts };
}
