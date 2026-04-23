import postgres from "postgres";

export type Sql = ReturnType<typeof postgres>;

let sqlInstance: Sql | null = null;

export function hasDb(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

export function sql(): Sql {
  if (!sqlInstance) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    sqlInstance = postgres(url, {
      ssl: /localhost|127\.0\.0\.1/.test(url) ? false : "require",
      max: Number(process.env.PG_POOL_MAX) || 5,
      idle_timeout: 20,
      max_lifetime: 60 * 30,
      prepare: false, // compatible with pgBouncer transaction mode (Neon / Supabase)
    });
  }
  return sqlInstance;
}

let migrated = false;
let migrating: Promise<void> | null = null;

export async function ensureMigrated(): Promise<void> {
  if (!hasDb()) return;
  if (migrated) return;
  if (migrating) return migrating;
  migrating = (async () => {
    const s = sql();
    await s.unsafe(MIGRATIONS);
    migrated = true;
    migrating = null;
  })();
  return migrating;
}

// Inline schema — keeps the project self-contained for a quick Vercel deploy.
// Run idempotently.
const MIGRATIONS = /* sql */ `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE,
  api_key TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  name TEXT,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  total INT NOT NULL DEFAULT 0,
  valid INT NOT NULL DEFAULT 0,
  invalid INT NOT NULL DEFAULT 0,
  errored INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_batches_user ON batches(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  domain TEXT,
  password_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_accounts_batch ON accounts(batch_id);
CREATE INDEX IF NOT EXISTS idx_accounts_domain ON accounts(domain);

CREATE TABLE IF NOT EXISTS checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  protocol TEXT NOT NULL, -- smtp | imap | pop3 | send | dns | deliverability
  ok BOOLEAN NOT NULL,
  host TEXT,
  port INT,
  tls_mode TEXT,
  error_category TEXT,
  error_message TEXT,
  elapsed_ms INT,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_checks_account ON checks(account_id);
CREATE INDEX IF NOT EXISTS idx_checks_protocol ON checks(protocol);
CREATE INDEX IF NOT EXISTS idx_checks_errcat ON checks(error_category) WHERE error_category IS NOT NULL;

CREATE TABLE IF NOT EXISTS contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  name TEXT,
  phone TEXT,
  org TEXT,
  source TEXT NOT NULL,
  folder TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(account_id, email, source)
);
CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);

-- Full-text search over extracted messages.
CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  folder TEXT,
  uid BIGINT,
  subject TEXT,
  from_addr TEXT,
  to_addrs TEXT[],
  sent_at TIMESTAMPTZ,
  body TEXT,
  tsv TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(subject,'')), 'A') ||
    setweight(to_tsvector('simple', coalesce(from_addr,'')), 'B') ||
    setweight(to_tsvector('simple', coalesce(array_to_string(to_addrs, ' '),'')), 'B') ||
    setweight(to_tsvector('simple', coalesce(body,'')), 'C')
  ) STORED
);
CREATE INDEX IF NOT EXISTS idx_messages_tsv ON messages USING GIN (tsv);
CREATE INDEX IF NOT EXISTS idx_messages_account ON messages(account_id);

CREATE TABLE IF NOT EXISTS audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor TEXT,            -- free-form actor (e.g. email or api-key fingerprint)
  action TEXT NOT NULL,
  target TEXT,           -- e.g. account email or domain
  ip TEXT,
  user_agent TEXT,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_events(action);

CREATE TABLE IF NOT EXISTS webhooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events TEXT[] NOT NULL DEFAULT ARRAY['check.completed'],
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id UUID NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  payload JSONB NOT NULL,
  status_code INT,
  response_snippet TEXT,
  attempts INT NOT NULL DEFAULT 1,
  success BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_deliveries_webhook ON webhook_deliveries(webhook_id, created_at DESC);

-- Queued jobs (QStash). One row per enqueued account verify/send.
CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID REFERENCES batches(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,            -- verify | send
  status TEXT NOT NULL DEFAULT 'queued', -- queued | running | done | error
  payload JSONB NOT NULL,
  result JSONB,
  error TEXT,
  attempts INT NOT NULL DEFAULT 0,
  message_id TEXT,               -- QStash message id
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_jobs_batch ON jobs(batch_id, status);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, created_at DESC);

-- Rate limiter hits (sliding window).
CREATE TABLE IF NOT EXISTS rate_hits (
  key TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rate_hits_key_at ON rate_hits(key, at DESC);
`;
