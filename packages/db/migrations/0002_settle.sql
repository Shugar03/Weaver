-- S17b — settlement por job en samples (nullable: samples viejos siguen válidos).
alter table performance_samples
  add column if not exists fund_tx text,
  add column if not exists release_tx text,
  add column if not exists settle_status text;
