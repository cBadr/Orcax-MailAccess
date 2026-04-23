export interface Credential {
  email: string;
  password: string;
  line: number;
}

const EMAIL_RE = /^[^\s:@]+@[^\s:@]+\.[^\s:@]+$/;

export function parseCredentials(text: string): Credential[] {
  const out: Credential[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw || raw.startsWith("#")) continue;

    const sep = raw.indexOf(":");
    if (sep <= 0) continue;

    const email = raw.slice(0, sep).trim().toLowerCase();
    const password = raw.slice(sep + 1);
    if (!EMAIL_RE.test(email)) continue;
    if (!password) continue;

    out.push({ email, password, line: i + 1 });
  }
  return out;
}

export function dedupeCredentials(creds: Credential[]): Credential[] {
  const seen = new Set<string>();
  const out: Credential[] = [];
  for (const c of creds) {
    const k = c.email + "\0" + c.password;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}
