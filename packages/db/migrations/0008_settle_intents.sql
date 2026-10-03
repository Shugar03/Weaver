-- S50 (I3, variante EVM): settle_intents — el proof se persiste ANTES de
-- fundJob (intent-first). job_key = keccak256(forgeSig), único por proof.
-- Invariante: si recordIntent no escribió, settleJob aborta antes de fondear
-- → jamás existe plata on-chain sin proof journalizado.
-- intent: proof guardado, jobId aún no minó.
-- funded|released|failed: como settle_jobs pero con job_id nullable hasta
-- que attachJob lo liga al evento Funded.
CREATE TABLE IF NOT EXISTS settle_intents (
  job_key TEXT PRIMARY KEY,
  worker TEXT NOT NULL,
  result_hash TEXT NOT NULL,
  forge_sig TEXT NOT NULL,
  job_id BIGINT,
  fund_tx TEXT,
  release_tx TEXT,
  state TEXT NOT NULL DEFAULT 'intent', -- intent|funded|released|failed
  fail_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS settle_intents_state ON settle_intents(state);
