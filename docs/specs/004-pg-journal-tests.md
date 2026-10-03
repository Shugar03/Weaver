# Spec 004 — PostgresIntentJournal: contract tests contra pg real

## Estado actual

`PostgresIntentJournal` existe (`packages/settlement/src/journal.ts`) y el
schema/migración `0008_settle_intents.sql` también. Todo lo probado es
`InMemoryIntentJournal` — el path `DATABASE_URL` de producción jamás corrió.

## Problema de entorno — RESUELTO distinto

El spec original proponía `pglite` (Postgres WASM) porque no había docker.
Resultado: **sí hay Postgres real** — `postgresql@16` via Homebrew corre
en `:5432` nativo. Mejor que pglite: es el mismo Postgres de producción,
sin dependencia nueva. pglite queda como fallback si no hubiera servidor.

## Diseño

1. DB de test `weaver_journal_test` (`createdb`), migraciones aplicadas con
   el runner real `node packages/db/migrate.mjs` (8/8 — así se testean
   también las migraciones sobre pg real).
2. **Contract tests parametrizados** `intent-journal-contract.test.ts`:
   misma suite sobre `InMemoryIntentJournal` y `PostgresIntentJournal`:
   recordIntent, attachJob, markReleased, markFailed, record() compat,
   discardIntent, attachJob no-op sobre key inexistente.
3. **Restart**: instancia nueva de `PostgresIntentJournal` contra la misma
   DB ve los intents de la anterior (datos en pg, no en el objeto).

## TDD

Test primero contra PostgresIntentJournal → donde falle, fix en el impl
(SQL o mapeo de filas), no en el test. InMemory se mantiene verde como
referencia de semántica.

## Non-goals

- Migrar el CI a pg externo — pglite es suficiente y self-contained.
- Benchmarks de escritura — el journal no es hot path (1 write/job).

## Status — VERIFIED (2025-10-03)

`tests/intent-journal-contract.test.ts` — **15/15 pass** contra
PostgreSQL 16 real (`postgres://localhost:5432/weaver_journal_test`):

- 7 casos de contrato × InMemory + 7 × Postgres + 1 restart pg-only.
- Migraciones 0001–0008 aplicadas por el runner real (sin saltos).
- Suite settlement completa: 83 pass / 1 skip (escrow-live) / 0 fail.
- Comando: `TEST_DATABASE_URL=postgres://…/weaver_journal_test node --test tests/intent-journal-contract.test.ts`
- Sin `TEST_DATABASE_URL` el bloque pg se auto-skippea — el suite sigue verde en CI sin DB.
