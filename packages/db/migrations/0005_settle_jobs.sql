-- S44 (ADR-0006, I3): journal de escrows — la referencia durable a todo
-- fund_job para que un crash entre fund y release jamás deje plata huérfana.
CREATE TABLE IF NOT EXISTS settle_jobs (
  job_id BIGINT PRIMARY KEY,
  worker TEXT NOT NULL,
  result_hash TEXT NOT NULL,
  forge_sig TEXT NOT NULL,
  fund_tx TEXT NOT NULL,
  release_tx TEXT,
  state TEXT NOT NULL DEFAULT 'funded', -- funded|released|failed
  fail_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
