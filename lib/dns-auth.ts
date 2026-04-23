import { promises as dns } from "dns";

export interface DnsAuthResult {
  domain: string;
  spf: { present: boolean; record?: string; mechanisms?: string[]; all?: "pass" | "softfail" | "neutral" | "fail" | null };
  dmarc: { present: boolean; record?: string; policy?: string; pct?: number; rua?: string[]; ruf?: string[] };
  dkim: { present: boolean; selectors: Array<{ selector: string; record: string }> };
  mx: string[];
  score: number; // 0..100 quick deliverability hint
  notes: string[];
}

const DEFAULT_SELECTORS = [
  "default",
  "selector1",
  "selector2",
  "google",
  "k1",
  "k2",
  "s1",
  "s2",
  "mail",
  "smtp",
  "dkim",
  "mandrill",
  "mxvault",
  "everlytickey1",
  "everlytickey2",
];

async function resolveTxtSafe(name: string): Promise<string[][]> {
  try {
    return await dns.resolveTxt(name);
  } catch {
    return [];
  }
}

function joinTxt(records: string[][]): string[] {
  return records.map((r) => r.join(""));
}

function parseSpf(record: string) {
  const parts = record.split(/\s+/).filter(Boolean);
  const mechanisms = parts.slice(1);
  const allTok = mechanisms.find((m) => /[-~?+]all$/.test(m));
  let all: DnsAuthResult["spf"]["all"] = null;
  if (allTok) {
    if (allTok.startsWith("-")) all = "fail";
    else if (allTok.startsWith("~")) all = "softfail";
    else if (allTok.startsWith("?")) all = "neutral";
    else if (allTok.startsWith("+") || allTok === "all") all = "pass";
  }
  return { mechanisms, all };
}

function parseDmarc(record: string) {
  const out: { policy?: string; pct?: number; rua?: string[]; ruf?: string[] } = {};
  for (const part of record.split(";").map((p) => p.trim()).filter(Boolean)) {
    const [k, v] = part.split("=").map((s) => s.trim());
    if (!k) continue;
    if (k === "p") out.policy = v;
    else if (k === "pct") out.pct = parseInt(v, 10);
    else if (k === "rua") out.rua = v.split(",").map((s) => s.trim());
    else if (k === "ruf") out.ruf = v.split(",").map((s) => s.trim());
  }
  return out;
}

export async function checkDnsAuth(domain: string, selectors: string[] = DEFAULT_SELECTORS): Promise<DnsAuthResult> {
  const notes: string[] = [];

  const [txtRoot, dmarcTxt, mx] = await Promise.all([
    resolveTxtSafe(domain).then(joinTxt),
    resolveTxtSafe(`_dmarc.${domain}`).then(joinTxt),
    dns.resolveMx(domain).catch(() => []),
  ]);

  const spfRecord = txtRoot.find((r) => /^v=spf1\b/i.test(r));
  const spf = spfRecord
    ? { present: true, record: spfRecord, ...parseSpf(spfRecord) }
    : { present: false as const };

  const dmarcRecord = dmarcTxt.find((r) => /^v=DMARC1\b/i.test(r));
  const dmarc = dmarcRecord
    ? { present: true as const, record: dmarcRecord, ...parseDmarc(dmarcRecord) }
    : { present: false as const };

  // DKIM: probe common selectors in parallel.
  const dkimHits = await Promise.all(
    selectors.map(async (sel) => {
      const recs = await resolveTxtSafe(`${sel}._domainkey.${domain}`).then(joinTxt);
      const hit = recs.find((r) => /v=DKIM1/i.test(r) || /k=rsa|p=/i.test(r));
      return hit ? { selector: sel, record: hit } : null;
    }),
  );
  const dkimSelectors = dkimHits.filter((x): x is { selector: string; record: string } => !!x);

  // Heuristic score.
  let score = 0;
  if (mx.length) score += 25;
  if (spf.present) score += (spf as any).all === "fail" || (spf as any).all === "softfail" ? 25 : 15;
  if (dmarc.present) score += /^(reject|quarantine)$/i.test(String((dmarc as any).policy)) ? 25 : 15;
  if (dkimSelectors.length) score += 25;
  score = Math.min(100, score);

  if (!mx.length) notes.push("No MX records: domain can neither send nor receive");
  if (!spf.present) notes.push("No SPF: outbound mail will likely fail SPF at receivers");
  if (!dmarc.present) notes.push("No DMARC: recipients have no alignment policy to enforce");
  if (!dkimSelectors.length) notes.push("No DKIM found on common selectors (could still exist on custom ones)");

  return {
    domain,
    spf,
    dmarc,
    dkim: { present: dkimSelectors.length > 0, selectors: dkimSelectors },
    mx: mx.map((m) => m.exchange),
    score,
    notes,
  } as DnsAuthResult;
}
