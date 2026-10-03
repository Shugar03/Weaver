# Spec 004 — PostgresIntentJournal: contract tests contra pg real

## Estado actual

`PostgresIntentJournal` existe (`packages/settlement/src/journal.ts`) y el
schema/migración `0008_settle_intents.sql` también. Todo lo probado es
`InMemoryIntentJournal` — el path `DATABASE_URL` de producción jamás corrió.

## Problema de entorno

No hay docker en la máquina → no hay Postgres real a mano. Solución:
`@electric-sql/pglite` + `pglite-socket` — Postgres **real** compilado a
WASM, servido por TCP en un puerto ephemeral. `postgres-js` (el driver de
`packages/db`) conecta normal con `DATABASE_URL`. Fidelidad real, cero
docker.

## Diseño

1. `packages/db` dev-dep: `@electric-sql/pglite` + `pglite-socket`.
2. Test helper `pgForTests()`: levanta pglite con socket en `:0` (puerto
   libre), aplica migraciones `migrations/*.sql` en orden (así se testean
   TAMBIÉN las migraciones — bonus real), devuelve `DATABASE_URL` efímero.
3. **Contract tests parametrizados**: la misma suite de comportamiento
   corre sobre `InMemoryIntentJournal` y `PostgresIntentJournal`:
   recordIntent idempotente por jobKey, attachJob, markReleased,
   intents() sin jobId, discardIntent con razón, orden de intents().
   Cualquier divergencia entre impls es un bug real.
4. Reusar para `PostgresSettleJournal` si ya existe (mismo patrón).

## TDD

Test primero contra PostgresIntentJournal → donde falle, fix en el impl
(SQL o mapeo de filas), no en el test. InMemory se mantiene verde como
referencia de semántica.

## Non-goals

- Migrar el CI a pg externo — pglite es suficiente y self-contained.
- Benchmarks de escritura — el journal no es hot path (1 write/job).
