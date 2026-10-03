# Spec 005 — Reconciler hardening: anti-solape + cursor durable + métricas

## Estado actual

`reconcileEvmOrphans` corre cada 60s vía `setInterval` (`serve.ts`). Tres
debilidades conocidas:

1. **Solape**: si un run tarda >60s (RPC lento), el siguiente tick arranca
   encima → doble release intent del mismo intent.
2. **Cursor fijo**: cada run escanea `Funded` desde `EVM_ESCROW_FROM_BLOCK`
   o lookback 500k — trabajo O(historia) por ciclo, creciente.
3. **Ciego**: recupera/descarta sin dejar conteo observable — un operador
   no ve "recuperé 2 escrows esta hora".

## Diseño

1. **Guard in-flight**: `reconcileEvmOrphans` recibe un flag compartido o
   wrapper `onceAtATime(fn)` — segunda invocación concurrente devuelve
   `{skipped:"in-flight"}` sin tocar nada. TDD: deps lentas + 2 llamadas
   concurrentes → la segunda skipea.
2. **Cursor durable**: el reconciler guarda `lastScannedBlock` (journal o
   tabla `meta`) y cada run escanea `[cursor, head-12]` (12 bloques de
   margen reorg — Monad ~1s/bloque → ~12s de lag aceptable). Cursor nuevo
   arranca en `EVM_ESCROW_FROM_BLOCK` o `head-lookback` (comportamiento
   actual). TDD: cursor avanza, reorg respeta el margen, cursor persistido
   sobrevive restart (test con journal real).
3. **Contadores**: resultado del run `{recovered, stale, pureOrphans,
   scanned}` → log line + `telemetría` (se ve en /network stats si la view
   lo expone — opcional, mínimo el log).

## TDD

Extender `reconcile.test.ts`: overlap guard, cursor advance, reorg margin,
métricas del run. Todo con deps mock — sin RPC live.

## Non-goals

- Alerting externo (métricas Prometheus) — fuera de scope.
- Backfill histórico completo — el lookback inicial ya lo cubre.
