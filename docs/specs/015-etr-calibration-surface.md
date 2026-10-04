# spec 015 — ETR calibration surface: "measured, not declared" es verificable

## Problema

El claim central del producto es *"el router elige por ETR medido, no por lo
que el forge declara"*. Spec 002 ya persiste `predictedMs` por sample (la
predicción que el router hizo para el forge que SIRVIÓ) y
`packages/telemetry/calibration.ts` computa el error relativo EMA por forge.
Pero nada lo expone: la función es código muerto y el claim no es verificable
desde fuera.

## Diseño

Nuevo dep opcional `calibrationOf(forgeId)` en `createApp`:

- `serve.ts` lo implementa sobre `telemetry.recent(N)` → `etrCalibration`.
- En `/v1/forges`, cada ForgeView gana `calibration?: {errPct, lastPredMs,
  lastActualMs}` — **omitted** cuando no hay pares (honesto: sin datos no hay
  número, jamás `null`).
- In-memory y pg comparten el mismo contrato: `etrCalibration` ya filtra
  `ok && predictedMs !== undefined` — un forge sin mediciones calibrables
  simplemente no lleva el campo.

## Cliente

- `/network` FleetSection: chip `ETR err N%` junto al ETR del forge + tooltip
  textual "predicho Xms → real Yms" — el claim queda demostrable en una
  mirada.
- Sin dato → sin chip. Nada de placeholders.

## Honestidad

- `lastActualMs = ttftMs + decodeMs` del sample real — mide lo que el usuario
  experimentó, no el clock del forge.
- errPct=0 significa "el router clavó", no "sin datos" (campo ausente = sin
  datos).

## Tests

- `/v1/forges` con `calibrationOf` → el campo aparece con el valor del dep.
- Sin dep / dep devuelve null → campo ausente (no `null`).
- Contrato `etrCalibration` ya testeado en telemetry; aquí solo el plumbing.
