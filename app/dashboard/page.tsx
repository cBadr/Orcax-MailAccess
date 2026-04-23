"use client";

import { useEffect, useState } from "react";

interface DashData {
  enabled: boolean;
  totals?: { accounts: number; valid: number; invalid: number };
  byDomain?: Array<{ domain: string; total: number; valid: number }>;
  byCategory?: Array<{ category: string; n: number }>;
  byTld?: Array<{ tld: string; total: number }>;
  avgLatency?: Array<{ protocol: string; host: string; avg_ms: number; n: number }>;
  byTlsMode?: Array<{ tls_mode: string; protocol: string; total: number; ok: number }>;
  recent?: Array<{ email: string; domain: string; status: string; created_at: string; batch_name?: string }>;
}

export default function DashboardPage() {
  const [data, setData] = useState<DashData | null>(null);
  const [err, setErr] = useState<string>("");

  async function load() {
    try {
      const r = await fetch("/api/dashboard", { cache: "no-store" });
      const text = await r.text();
      if (!text) {
        setData({ enabled: false });
        setErr(`Empty response (HTTP ${r.status})`);
        return;
      }
      let j: any;
      try {
        j = JSON.parse(text);
      } catch {
        setData({ enabled: false });
        setErr(`Non-JSON response (HTTP ${r.status}): ${text.slice(0, 200)}`);
        return;
      }
      setData(j);
      setErr(j?.error || "");
    } catch (e: any) {
      setErr(String(e?.message || e));
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, []);

  if (!data) {
    return (
      <div className="container">
        <h1>Dashboard</h1>
        <div className="card">{err || "Loading..."}</div>
      </div>
    );
  }

  if (!data.enabled) {
    return (
      <div className="container">
        <h1>Dashboard</h1>
        <div className="card">
          <p>Database not configured. Set <span className="mono">DATABASE_URL</span> in Vercel (or <span className="mono">.env.local</span>) to enable analytics, audit log, webhooks, and full-text search.</p>
          {err ? <p className="error mono">{err}</p> : null}
          <p><a href="/">← back to checker</a></p>
        </div>
      </div>
    );
  }

  const totals = data.totals || { accounts: 0, valid: 0, invalid: 0 };
  const successRate = totals.accounts ? Math.round((totals.valid / totals.accounts) * 100) : 0;

  return (
    <div className="container">
      <h1>Dashboard</h1>
      <div className="sub">Aggregate view across all batches. Refreshes every 10s.</div>

      <div className="card row">
        <div className="pill">Accounts {totals.accounts}</div>
        <div className="pill ok">Valid {totals.valid}</div>
        <div className="pill bad">Invalid {totals.invalid}</div>
        <div className="pill">Success rate {successRate}%</div>
        <a href="/" className="pill">← checker</a>
      </div>

      <div className="card">
        <strong>Top providers (by domain)</strong>
        <table style={{ marginTop: 8 }}>
          <thead><tr><th>Domain</th><th>Total</th><th>Valid</th><th>Rate</th></tr></thead>
          <tbody>
            {(data.byDomain || []).map((d) => (
              <tr key={d.domain}>
                <td className="mono">{d.domain}</td>
                <td className="mono">{d.total}</td>
                <td className="mono">{d.valid}</td>
                <td className="mono">{d.total ? Math.round((d.valid / d.total) * 100) : 0}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <strong>Most common error categories</strong>
        <table style={{ marginTop: 8 }}>
          <thead><tr><th>Category</th><th>Count</th></tr></thead>
          <tbody>
            {(data.byCategory || []).map((c) => (
              <tr key={c.category}><td className="mono">{c.category}</td><td className="mono">{c.n}</td></tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <strong>TLD distribution</strong>
        <table style={{ marginTop: 8 }}>
          <thead><tr><th>TLD</th><th>Accounts</th></tr></thead>
          <tbody>
            {(data.byTld || []).map((t) => (
              <tr key={t.tld}><td className="mono">.{t.tld}</td><td className="mono">{t.total}</td></tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <strong>Fastest hosts (successful checks)</strong>
        <table style={{ marginTop: 8 }}>
          <thead><tr><th>Protocol</th><th>Host</th><th>Avg ms</th><th>Samples</th></tr></thead>
          <tbody>
            {(data.avgLatency || []).map((l, i) => (
              <tr key={i}>
                <td className="mono">{l.protocol}</td>
                <td className="mono">{l.host}</td>
                <td className="mono">{l.avg_ms}</td>
                <td className="mono">{l.n}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <strong>TLS mode success</strong>
        <table style={{ marginTop: 8 }}>
          <thead><tr><th>Protocol</th><th>TLS</th><th>OK / Total</th><th>Rate</th></tr></thead>
          <tbody>
            {(data.byTlsMode || []).map((r, i) => (
              <tr key={i}>
                <td className="mono">{r.protocol}</td>
                <td className="mono">{r.tls_mode}</td>
                <td className="mono">{r.ok} / {r.total}</td>
                <td className="mono">{r.total ? Math.round((r.ok / r.total) * 100) : 0}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <strong>Recent accounts</strong>
        <table style={{ marginTop: 8 }}>
          <thead><tr><th>Email</th><th>Status</th><th>Batch</th><th>When</th></tr></thead>
          <tbody>
            {(data.recent || []).map((r) => (
              <tr key={r.email + r.created_at}>
                <td className="mono">{r.email}</td>
                <td><span className={`pill ${r.status === "valid" ? "ok" : r.status === "invalid" ? "bad" : ""}`}>{r.status}</span></td>
                <td className="mono">{r.batch_name || ""}</td>
                <td className="mono">{new Date(r.created_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
