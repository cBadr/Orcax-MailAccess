// Pluggable deliverability providers. Both flows follow the same shape:
// (1) reserve a unique inbox to send to, (2) send via our SMTP checker,
// (3) later fetch the scored report.

export interface DeliverabilityTarget {
  provider: "mail-tester" | "glockapps";
  address: string;            // inbox to send the test email to
  testId?: string;             // provider-side identifier used to fetch the report
  reportUrl?: string;          // human-readable report link to poll/open
  accountId?: string;
}

export interface DeliverabilityReport {
  ok: boolean;
  provider: string;
  score?: number;
  maxScore?: number;
  inboxPlacement?: { inbox?: number; spam?: number; missing?: number; tabs?: Record<string, number> };
  details?: unknown;
  error?: string;
  reportUrl?: string;
}

/**
 * Mail-Tester flow.
 * Public (no-API) flow: user generates a unique test address on mail-tester.com,
 * sends their test email to it, then reads the scored report on the same site.
 * Our job is to accept that address + the test id and optionally fetch the JSON
 * report if the user provides an API token.
 */
export function mailTesterTarget(address: string): DeliverabilityTarget {
  // Mail-tester address format: test-<id>@srv1.mail-tester.com
  const m = /test-([a-z0-9]+)@/i.exec(address);
  const testId = m?.[1];
  return {
    provider: "mail-tester",
    address,
    testId,
    reportUrl: testId ? `https://www.mail-tester.com/${testId}` : undefined,
  };
}

export async function fetchMailTesterReport(testId: string, apiToken?: string): Promise<DeliverabilityReport> {
  if (!apiToken) {
    return {
      ok: false,
      provider: "mail-tester",
      error: "Mail-Tester API token required to fetch JSON report (open the web URL instead)",
      reportUrl: `https://www.mail-tester.com/${testId}`,
    };
  }
  try {
    const r = await fetch(`https://www.mail-tester.com/${testId}&format=json`, {
      headers: { authorization: `Bearer ${apiToken}` },
    });
    const j: any = await r.json();
    return {
      ok: true,
      provider: "mail-tester",
      score: typeof j?.score === "number" ? j.score : undefined,
      maxScore: 10,
      details: j,
      reportUrl: `https://www.mail-tester.com/${testId}`,
    };
  } catch (e: any) {
    return { ok: false, provider: "mail-tester", error: String(e?.message || e) };
  }
}

/**
 * GlockApps flow.
 * Requires an API key. Start a new test → get seed list + testId → send to seeds →
 * poll for results by testId.
 */
export async function glockAppsStart(apiKey: string): Promise<{ testId: string; seeds: string[]; reportUrl?: string } | { error: string }> {
  try {
    const r = await fetch("https://api.glockapps.com/v1/tests", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ type: "inbox-placement" }),
    });
    const j: any = await r.json();
    if (!r.ok) return { error: j?.error || `glockapps ${r.status}` };
    return { testId: j.id, seeds: j.seeds || [], reportUrl: j.reportUrl };
  } catch (e: any) {
    return { error: String(e?.message || e) };
  }
}

export async function glockAppsFetch(apiKey: string, testId: string): Promise<DeliverabilityReport> {
  try {
    const r = await fetch(`https://api.glockapps.com/v1/tests/${encodeURIComponent(testId)}`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const j: any = await r.json();
    if (!r.ok) return { ok: false, provider: "glockapps", error: j?.error || `http ${r.status}` };
    const placement = j.placement || j.inbox || {};
    return {
      ok: true,
      provider: "glockapps",
      score: typeof j.score === "number" ? j.score : undefined,
      maxScore: 100,
      inboxPlacement: {
        inbox: placement.inbox,
        spam: placement.spam,
        missing: placement.missing,
        tabs: placement.tabs,
      },
      details: j,
      reportUrl: j.reportUrl,
    };
  } catch (e: any) {
    return { ok: false, provider: "glockapps", error: String(e?.message || e) };
  }
}
