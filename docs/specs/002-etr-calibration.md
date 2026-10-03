# Spec 002 — ETR calibration visible

## Por qué

El claim del producto es "routing por ETR **medido**, no declarado". Hoy el
ETR predicho existe internamente pero nunca se contrasta con lo real —
`reliability` sale hardcodeado `1` en las views. Sin contraste, el claim es
retórica.

## Goal

`/v1/forges` expone por forge: `etrMs` (predicción vigente del próximo job),
`etrActual` (real del último job), `etrError` (% de error rolling). `/network`
lo muestra honesto: `pred 2.1s → real 1.9s (Δ9%)`. Sin muestras → `—`, jamás
números inventados.

## Diseño

1. **Donde ya se predice**: el routing elige `minETR` por candidato
   (queue+exec estimado). Ese `expectedMs` ya viaja hacia el dispatch —
   persistirlo en el record del job como `predictedMs`.
2. **Al completar**: telemetría ya graba `latencyMs`/`ttftMs`/`tokS` reales.
   El calibrado por forge = EMA del error relativo
   `|predicted-actual|/actual` (α=0.3, igual al resto de EMAs del sistema).
3. **View**: `ForgeView` agrega `etrMs` (live, del queue-depth + decode EMA
   actuales — el mismo cálculo que el routing hace en selección),
   `etrLastActual`, `etrErrorPct`. Todo `null` hasta primer job.
4. **Web**: columna `ETR` en FleetSection muestra `pred→real` + Δ% coloreado
   (verde <20%, ámbar <50%, rojo >50% — honestidad visible, no escondida).

## TDD

- `calibration.test.ts`: job con predicted=2000, actual=1800 → error 11.1%;
  EMA converge; forge sin jobs → campos `null` en view.
- Routing integration: el `predictedMs` del candidato elegido llega al record
  (test con fleet mock que lee el record persistido).
- Web typecheck.

## Non-goals

- Re-pesos del scheduler con el error (la medición informa, aún no cierra
  el loop de control — sería siguiente iteración).
- Histogramas p50/p99 — solo EMA simple por ahora.
