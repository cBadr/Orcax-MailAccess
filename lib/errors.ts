export type ErrorCategory =
  | "auth_failed"
  | "2fa_required"
  | "app_password_required"
  | "rate_limited"
  | "tls_error"
  | "cert_error"
  | "host_unreachable"
  | "dns_error"
  | "connection_timeout"
  | "protocol_error"
  | "quota_exceeded"
  | "relay_denied"
  | "sender_rejected"
  | "recipient_rejected"
  | "unknown";

export interface CategorizedError {
  category: ErrorCategory;
  message: string;
  raw?: string;
}

// Keep patterns ordered — most specific first.
const PATTERNS: Array<[ErrorCategory, RegExp]> = [
  ["2fa_required", /two[- ]?factor|2fa|mfa|verification code|application-specific password|app password/i],
  ["app_password_required", /web ?login required|less secure|enable imap|application.specific/i],
  ["rate_limited", /rate limit|too many|try again later|temporary.*error|421|450|451|quota.*reached/i],
  ["quota_exceeded", /over ?quota|mailbox full|552|exceeded/i],
  ["auth_failed", /invalid (login|credentials|user)|authentication (failed|unsuccessful)|535|534|530|no such user|bad username|wrong password|login failed|auth.*reject/i],
  ["sender_rejected", /sender.*rejected|sender.*denied|not permitted as sender|550 5\.7|553|access denied/i],
  ["recipient_rejected", /recipient.*rejected|no such (address|recipient)|550 5\.1|user unknown/i],
  ["relay_denied", /relay(ing)? (denied|not allowed|access denied)|554 5\.7\.1/i],
  ["cert_error", /self[- ]?signed|unable to verify|cert.*(chain|expired|invalid)|depth zero|UNABLE_TO_VERIFY/i],
  ["tls_error", /tls|ssl|handshake|wrong version|protocol version|EPROTO|SSL routines|alert/i],
  ["dns_error", /ENOTFOUND|EAI_AGAIN|getaddrinfo|no servers could be reached/i],
  ["connection_timeout", /timeout|timed out|ETIMEDOUT|ECONNRESET|greeting never received/i],
  ["host_unreachable", /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|unreachable/i],
  ["protocol_error", /parse|unexpected (response|reply)|bad command|syntax error|500|502|503/i],
];

export function categorize(err: unknown): CategorizedError {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  for (const [cat, re] of PATTERNS) {
    if (re.test(raw)) return { category: cat, message: raw, raw };
  }
  return { category: "unknown", message: raw, raw };
}

export function isDefinitive(cat: ErrorCategory): boolean {
  // A definitive result means "no point trying another host/port".
  return (
    cat === "auth_failed" ||
    cat === "2fa_required" ||
    cat === "app_password_required" ||
    cat === "quota_exceeded" ||
    cat === "sender_rejected" ||
    cat === "recipient_rejected" ||
    cat === "relay_denied"
  );
}
