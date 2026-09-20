-- S16a — migración inicial (aplicar en Supabase dashboard → SQL editor).
-- Solo tablas vivas del gateway. jobs/forges/instances/settlements post-hackathon.
create table if not exists api_keys (
  id text primary key,
  owner text not null,
  hash text not null,
  created_at timestamptz not null default now(),
  revoked boolean not null default false
);

create table if not exists performance_samples (
  id bigint primary key generated always as identity,
  forge_id text not null,
  model text not null,
  ttft_ms bigint not null,
  ok boolean not null,
  ts bigint not null,
  key_id text
);
create index if not exists samples_model_ts_idx on performance_samples (model, ts);
