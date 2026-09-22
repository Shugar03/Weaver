# ADR 0003 — Capabilities de forge, métricas solo-medidas y chaos granular

Fecha: 2026-09-21 · Estado: aceptado

## Contexto

La fleet creció de "un Ollama" a 4 forges con 2 modalidades (texto vía
`ForgeExec`, imagen vía `ImageExec`), y el dashboard mostraba números que no
medía: `LOAD%` derivado de `loadTimeMs`, `reliability` hardcodeada, tabs de
modelos sin forge (`SIN FORGE`), earnings con fórmula inventada. Además el
selector del chat listaba el modelo de imagen como chateable y moría en
routing (`sin execs para flux2-klein-4b`).

## Decisión

1. **`ForgeView.capability?: "text" | "image"`** — ausente significa `text`
   (compat). `/v1/models` y `/v1/chat/completions` solo ven texto;
   `/v1/images/generations` solo candidatos `image` con `ImageExec`
   registrado. El routing cruza-modalidad se rechaza en el borde, no falla
   adentro.
2. **Dashboard = solo lo medido.** La métrica por forge sale de telemetría
   (`/v1/executions`): p50 TTFT para texto, ms/img para imagen, carga fría
   declarada cuando el forge está COLD. Si no lo medimos, no se muestra —
   ni reliability, ni load, ni earnings sin settle real.
3. **Chaos granular**: `POST /v1/admin/kill` acepta `{ dead, forgeId? }`.
   Sin `forgeId` = primario (compat hacia atrás). Cada forge local es
   `SwitchableExec` propio; id desconocido → 404 honesto.
4. **`/forge` = índice de fleet; `/forge/[id]` = consola de ese forge.**
   Nada hardcodeado: id, modelo y jobs vienen del view + telemetría
   (`/v1/executions?forgeId=`). `/api/ps` se consulta por modelo residente
   del forge, no `ps[0]`.

## Consecuencias

- Agregar una modalidad nueva = nuevo valor de `capability` + su `Exec`
  port + filtro en el borde correspondiente. No toca al scheduler.
- Toda superficie de UI que muestre un número debe poder nombrar la
  telemetría que lo produce; si no, es placeholder y se borra.
- El evento `weaver:forge` del browser alimenta el flash de la fila que
  sirvió — el routing es visible, no implícito.
