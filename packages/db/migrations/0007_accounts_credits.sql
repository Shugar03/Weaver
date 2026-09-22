-- S47 (ADR-0007): cuentas de usuario + ledger de créditos.
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  mgmt_token_hash TEXT,
  wallet_pubkey TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS account_sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS credit_events (
  id BIGSERIAL PRIMARY KEY,
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL, -- topup | debit
  amount BIGINT NOT NULL, -- stroops
  ref TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS credit_events_kind_ref ON credit_events (kind, ref);
