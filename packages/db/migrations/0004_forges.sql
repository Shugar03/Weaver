-- S30: identidades de forges remotos (ADR-0005). El estado vivo es efímero
-- (heartbeat); acá persiste solo quién ES el forge: pubkey = identidad + payout.
CREATE TABLE IF NOT EXISTS forges (
  pubkey TEXT PRIMARY KEY,
  display_name TEXT,
  attested BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
