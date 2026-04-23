import nodemailer from "nodemailer";
import type { MailHost } from "./autodiscover";

export interface SmtpResult {
  ok: boolean;
  host?: string;
  port?: number;
  secure?: boolean;
  error?: string;
}

function buildTransport(email: string, password: string, h: MailHost, timeoutMs: number) {
  return nodemailer.createTransport({
    host: h.host,
    port: h.port,
    secure: h.secure,
    auth: { user: email, pass: password },
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
    tls: { rejectUnauthorized: false },
  });
}

export async function verifySmtp(
  email: string,
  password: string,
  hosts: MailHost[],
  timeoutMs = 8000,
): Promise<SmtpResult> {
  let lastErr = "no hosts";
  for (const h of hosts) {
    const transporter = buildTransport(email, password, h, timeoutMs);
    try {
      await transporter.verify();
      return { ok: true, host: h.host, port: h.port, secure: h.secure };
    } catch (e: any) {
      const msg = String(e?.message || e);
      lastErr = msg;
      if (/invalid login|auth|535|534|authentication/i.test(msg)) {
        return { ok: false, host: h.host, port: h.port, secure: h.secure, error: msg };
      }
    } finally {
      transporter.close();
    }
  }
  return { ok: false, error: lastErr };
}

export interface SendTestOptions {
  to: string[];
  subject?: string;
  text?: string;
  html?: string;
  fromName?: string;
}

export interface SendTestResult {
  ok: boolean;
  host?: string;
  port?: number;
  messageId?: string;
  accepted?: string[];
  rejected?: string[];
  response?: string;
  error?: string;
}

export async function sendTest(
  email: string,
  password: string,
  hosts: MailHost[],
  opts: SendTestOptions,
  timeoutMs = 12000,
): Promise<SendTestResult> {
  const to = opts.to.map((t) => t.trim()).filter(Boolean);
  if (!to.length) return { ok: false, error: "no recipients" };

  const subject = opts.subject || "SMTP test";
  const text = opts.text || `SMTP test sent from ${email} at ${new Date().toISOString()}`;
  const from = opts.fromName ? `"${opts.fromName.replace(/"/g, "")}" <${email}>` : email;

  let lastErr = "no hosts";
  for (const h of hosts) {
    const transporter = buildTransport(email, password, h, timeoutMs);
    try {
      const info = await transporter.sendMail({
        from,
        to,
        subject,
        text,
        html: opts.html,
      });
      return {
        ok: true,
        host: h.host,
        port: h.port,
        messageId: info.messageId,
        accepted: (info.accepted as any[])?.map(String),
        rejected: (info.rejected as any[])?.map(String),
        response: info.response,
      };
    } catch (e: any) {
      const msg = String(e?.message || e);
      lastErr = msg;
      if (/invalid login|auth|535|534|authentication|sender|relay|550|553|554/i.test(msg)) {
        return { ok: false, host: h.host, port: h.port, error: msg };
      }
    } finally {
      transporter.close();
    }
  }
  return { ok: false, error: lastErr };
}
