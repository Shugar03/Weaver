# ADR 0002 — Postgres en VPS propio (antes: Supabase cloud) + Redis cloud, nada local pesado

Fecha: 2026-09-14 · Estado: modificado 2026-09-20

## Enmienda 20/09

Supabase descartado (decisión del equipo: un vendor menos, cero cuentas nuevas).
Postgres corre en el mismo VPS del gateway (`DATABASE_URL` interna, migration por
`psql`). El código no cambió: `packages/db` es Postgres pelado, vendor-agnóstico.
Redis/Upstash sigue igual (queue/rate post-hackathon).

## Contexto

Air M5 16GB fanless: cada GB cuenta. Docker Desktop idle come ~2GB, Postgres local + Redis + 2 modelos 7B + Next dev = swap asegurado.

## Decisión

Supabase Postgres + Drizzle para `jobs, forges, model_instances, performance_samples, executions, settlements`. Upstash Redis para queue/rate. Cero Docker local para datos.

## Alternativas

- Postgres+Redis en Docker local: más fiel a prod, pero te deja sin RAM para el modelo Hero 8B en demo.
- SQLite local: ahorra RAM pero bifurca SQL y rompe `pgvector`/RLS si los necesitamos post-hackathon.

## Consecuencias

- `DATABASE_URL` y `REDIS_URL` en `.env.local`, nunca en memoria ni en git.
- Benchmarks y dashboard leen las mismas tablas que usará prod. Sin migración懶 después.
