-- S23 — pata cliente del settle: tx x402 (cliente→operador) en samples.
alter table performance_samples
  add column if not exists payer_tx text;
