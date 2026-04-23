import nodemailer, { type Transporter } from "nodemailer";
import type { MailHost } from "./autodiscover";
import { categorize, isDefinitive, type CategorizedError } from "./errors";

export interface SmtpResult {
  ok: boolean;
  host?: string;
  port?: number;
  tlsMode?: string;
  error?: CategorizedError;
}

export interface Attachment {
  filename: string;
  content: string; // base64 when isBase64, else utf-8 text
  isBase64?: boolean;
  contentType?: string;
}

export interface SendTestOptions {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  text?: string;
  html?: string;
  attachments?: Attachment[];
  fromName?: string;
  replyTo?: string;
  trackingId?: string; // used to build a deterministic Message-ID
  headers?: Record<string, string>;
}

export interface SendTestResult {
  ok: boolean;
  host?: string;
  port?: number;
  tlsMode?: string;
  messageId?: string;
  accepted?: string[];
  rejected?: string[];
  response?: string;
  error?: CategorizedError;
}

function buildTransport(email: string, password: string, h: MailHost, timeoutMs: number): Transporter {
  // nodemailer accepts secure=true for implicit TLS and secure=false + requireTLS for STARTTLS.
  const secure = h.tlsMode === "implicit";
  const requireTLS = h.tlsMode === "starttls";
  const ignoreTLS = h.tlsMode === "plain";
  return nodemailer.createTransport({
    host: h.host,
    port: h.port,
    secure,
    requireTLS,
    ignoreTLS,
    auth: { user: email, pass: password },
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
    tls: { rejectUnauthorized: false, minVersion: "TLSv1" },
  });
}

export async function verifySmtp(
  email: string,
  password: string,
  hosts: MailHost[],
  timeoutMs = 8000,
): Promise<SmtpResult> {
  let lastErr: CategorizedError = categorize("no hosts");
  for (const h of hosts) {
    const transporter = buildTransport(email, password, h, timeoutMs);
    try {
      await transporter.verify();
      return { ok: true, host: h.host, port: h.port, tlsMode: h.tlsMode };
    } catch (e: any) {
      const cat = categorize(e);
      lastErr = cat;
      if (isDefinitive(cat.category)) {
        return { ok: false, host: h.host, port: h.port, tlsMode: h.tlsMode, error: cat };
      }
    } finally {
      transporter.close();
    }
  }
  return { ok: false, error: lastErr };
}

function buildMessageId(email: string, trackingId?: string): string {
  const domain = email.split("@")[1] || "localhost";
  const id = trackingId || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `<${id}@mailchecker.${domain}>`;
}

function materializeAttachments(list: Attachment[] | undefined) {
  if (!list || !list.length) return undefined;
  return list.map((a) => ({
    filename: a.filename,
    content: a.isBase64 ? Buffer.from(a.content, "base64") : a.content,
    contentType: a.contentType,
  }));
}

export async function sendTest(
  email: string,
  password: string,
  hosts: MailHost[],
  opts: SendTestOptions,
  timeoutMs = 15000,
): Promise<SendTestResult> {
  const to = opts.to.map((t) => t.trim()).filter(Boolean);
  if (!to.length) return { ok: false, error: categorize("no recipients") };

  const subject = opts.subject || "SMTP deliverability test";
  const text = opts.text || `SMTP test sent from ${email} at ${new Date().toISOString()}`;
  const from = opts.fromName ? `"${opts.fromName.replace(/"/g, "")}" <${email}>` : email;
  const messageId = buildMessageId(email, opts.trackingId);
  const headers: Record<string, string> = { ...(opts.headers || {}) };
  if (opts.trackingId) headers["X-Tracking-Id"] = opts.trackingId;

  let lastErr: CategorizedError = categorize("no hosts");
  for (const h of hosts) {
    const transporter = buildTransport(email, password, h, timeoutMs);
    try {
      const info = await transporter.sendMail({
        from,
        to,
        cc: opts.cc,
        bcc: opts.bcc,
        replyTo: opts.replyTo,
        subject,
        text,
        html: opts.html,
        attachments: materializeAttachments(opts.attachments),
        messageId,
        headers,
      });
      return {
        ok: true,
        host: h.host,
        port: h.port,
        tlsMode: h.tlsMode,
        messageId: info.messageId || messageId,
        accepted: (info.accepted as any[])?.map(String),
        rejected: (info.rejected as any[])?.map(String),
        response: info.response,
      };
    } catch (e: any) {
      const cat = categorize(e);
      lastErr = cat;
      if (isDefinitive(cat.category)) {
        return { ok: false, host: h.host, port: h.port, tlsMode: h.tlsMode, error: cat };
      }
    } finally {
      transporter.close();
    }
  }
  return { ok: false, error: lastErr };
}
