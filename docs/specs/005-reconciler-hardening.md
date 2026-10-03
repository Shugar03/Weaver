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

## Status — VERIFIED (2025-10-03)

Implementado en `createEvmReconciler` (`packages/settlement/src/evm.ts`) —
`reconcileEvmOrphans` queda puro (matching); el runner decide ventana/guard:

1. **Guard anti-solape**: `run()` concurrente → `{skipped:true}`. Un solo
   scan a la vez (test con headBlock bloqueado + 2 llamadas → 1 skip).
2. **Cursor durable** `scan_cursors` (migración `0009`): `PostgresScanCursor`
   con `DATABASE_URL`, `InMemoryScanCursor` en dev. Tras run limpio, el
   próximo scan va `[cursor-64, head]` (overlap reorg `REORG_OVERLAP_BLOCKS`,
   más conservador que los 12 del diseño — cubre también la carrera entre
   headBlock y el minado del Funded).
3. **Regla anti-regresión** (mejora sobre el diseño): el cursor SOLO avanza
   cuando `intentsWithoutJob()` queda vacío. Un intent pendiente cuyo Funded
   quedó detrás del cursor jamás se re-escanearía → plata recuperable
   convertida en huérfano permanente. Con intents abiertos la ventana se
   congela hasta que se attacheen o descarten.
4. **Bug real corregido**: `fetchFunded` tragaba errores RPC con
   `.catch(() => [])` — un scan caído era indistinguible de "sin eventos" y
   `discardIntent` borraba intents con Funded real. Ahora propaga: el ciclo
   falla, el cursor no avanza, reintenta. Además `readJob` ilegible marca
   `hadUnknown` → el intent sobrevive (discard solo con evidencia completa).

**Tests**: `reconcile-hardening.test.ts` 5/5 + `reconcile.test.ts` 7/7 +
cursor pg en `intent-journal-contract.test.ts` (upsert + persistencia entre
instancias). Gateway 135/135.

**Live**: gateway :3501 dual con `db=pg` — boot reconcile escaneó desde
floor `67916000` → head, cursor persistido `evm-reconcile → 67950338`
en `weaver_dev.scan_cursors`.
