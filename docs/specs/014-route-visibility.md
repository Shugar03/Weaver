# spec 014 — Route visibility: el failover se VE en el stream

## Problema

`FailoverForgeExec` rerutea pre-token de forma transparente — bien para el
usuario, mal para la demo: matar un forge y ver el stream continuar no
muestra NADA. El failover, nuestro momento más fuerte, es invisible.

## Diseño

El gateway ya recibe cada intento vía `req.onFail(fid)` y al servidor vía
`req.onForge(fid)`. Se emite un frame meta `weaver_route` cuando hubo
intentos fallidos:

- **Stream (SSE)**: al primer chunk de contenido, si `failed.length > 0`
  → `data: {"weaver_route":{"failed":[...],"serving":"<forgeId>"}}` antes
  de los tokens. El cliente muestra el reroute real (forge muerto →
  forge que sirvió), no una animación.
- **Non-stream**: `weaver_route` como campo top-level del JSON si hubo
  intentos.

Ausencia del frame = ruteo directo al primero (nada que reportar). Jamás se
inventa: los ids son los que `onFail`/`onForge` reportaron de verdad.

## Cliente

`runChat`/`runAgent` parsean `weaver_route` → `cb.onRoute`. ChatApp muestra
un badge compacto `live1 → live2` sobre la respuesta — el failover queda
legible sin ensuciar el contenido.
## Honestidad

- Pre-token: `failed` lista intentos reales; `serving` es el `forgeId` que
  entregó el primer token (puede diferir del forge que el scheduler eligió —
  la decisión documenta la intención, la ruta documenta lo que pasó).
- Mid-stream: si el forge muere ya streameando, la muerte va como evento
  `forge-failed` explícito (spec existente) — `weaver_route` no convierte un
  truncado en éxito.

## Tests

- `routevisibility.test.ts`: SSE con y sin failover, JSON non-stream.
- Mid-stream → error explícito (cubierto por `failover.test.ts` existente).
