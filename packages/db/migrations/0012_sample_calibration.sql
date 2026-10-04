-- spec 015: calibración del ETR + stats del engine en pg. PostgresTelemetry
-- dropeaba predictedMs/genTokens/decodeMs (in-memory las guardaba) → la
-- calibración (spec 002) y el tok/s medido (S28) morían solo en prod.
ALTER TABLE performance_samples
  ADD COLUMN IF NOT EXISTS predicted_ms BIGINT,
  ADD COLUMN IF NOT EXISTS gen_tokens BIGINT,
  ADD COLUMN IF NOT EXISTS decode_ms BIGINT;
