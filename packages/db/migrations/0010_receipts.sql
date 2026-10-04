-- spec 009: receipt verificable por ejecución. El sample guarda el jobId
-- chatcmpl (lookup del receipt) y el proof L0 que el forge firmó — así
-- /v1/executions puede servir la evidencia completa post-facto.
ALTER TABLE performance_samples
  ADD COLUMN IF NOT EXISTS job_id TEXT,
  ADD COLUMN IF NOT EXISTS result_hash TEXT,
  ADD COLUMN IF NOT EXISTS proof_sig TEXT;

CREATE INDEX IF NOT EXISTS samples_job_id_idx ON performance_samples (job_id);
