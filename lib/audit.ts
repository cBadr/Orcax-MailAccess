import { NextRequest } from "next/server";
import { ensureMigrated, hasDb, sql } from "./db";

export interface AuditInput {
  actor?: string;
  action: string;
  target?: string;
  userId?: string;
  details?: unknown;
  ip?: string;
  userAgent?: string;
}

export function clientMeta(req: NextRequest) {
  const h = req.headers;
  const fwd = h.get("x-forwarded-for") || "";
  const ip = fwd.split(",")[0].trim() || h.get("x-real-ip") || undefined;
  const userAgent = h.get("user-agent") || undefined;
  return { ip, userAgent };
}

export async function audit(entry: AuditInput): Promise<void> {
  if (!hasDb()) return; // no-op until DB is configured
  try {
    await ensureMigrated();
    const s = sql();
    await s`
      INSERT INTO audit_events (user_id, actor, action, target, ip, user_agent, details)
      VALUES (
        ${entry.userId ?? null},
        ${entry.actor ?? null},
        ${entry.action},
        ${entry.target ?? null},
        ${entry.ip ?? null},
        ${entry.userAgent ?? null},
        ${entry.details ? s.json(entry.details as any) : null}
      )
    `;
  } catch {
    // Audit must never break the main flow.
  }
}
