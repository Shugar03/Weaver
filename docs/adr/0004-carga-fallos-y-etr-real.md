# ADR 0004 — Carga medida, circuit breaker, admission control y ETR size-aware

Fecha: 2026-09-21 · Estado: aceptado

## Contexto

El scheduler era un warm-first heuristic correcto para un usuario, no un
sistema de asignación: `queueMs` era una constante declarada (0 real, 99999
como marcador de muerto), el p50 era all-time (un forge degradado arrastraba
su mediana buena vieja), los fallos de exec absorbidos por failover no se
registraban por forge (un forge roto con probe vivo se intentaba primero en
cada request), y el ETR medía TTFT solamente — un ping de 10 tokens y un
essay de 2000 ruteaban idéntico.

## Decisión

1. **`queueMs` medido, no declarado.** `TrackedExec` envuelve cada
   `ForgeExec`/`ImageExec` en el composition root y cuenta in-flight real
   (dentro del async generator: suma al primer token, resta al cerrar,
   cancelar o fallar). `queueMs = inFlight × expectedMs` donde `expectedMs`
   es el p50 medido (o `loadTimeMs`/500ms sin historia).
2. **`p50` con ventana.** `P50_WINDOW = 50` — los últimos N samples ok del
   forge, en memoria y en Postgres (`ORDER BY ts DESC LIMIT 50` antes del
   `percentile_cont`). La mediana refleja el ahora, no la historia.
3. **Circuit breaker por forge.** `onFail` en `ExecRequest` reporta cada
   intento fallido (pre-token y mid-stream, incluidos los absorbidos por
   failover); `onForge` reporta éxito. `CircuitBreaker`: ≥3 fallos en 60s →
   forge fuera 30s (`applyBreaker` lo expone como `queueMs = 99999`). Un
   revive por chaos resetea.
4. **ETR size-aware.** `Job.estOutTokens` = `max_tokens` del request;
   `Sample.genTokens/decodeMs` vienen del frame done del engine (Ollama los
   reporta gratis); `tokPerSec` por forge = Σgen/Σdecode medido. Con ambos,
   `ETR += estOut/tokPerSec` — time-to-result real.
5. **Admission control.** `ForgeView.saturated` = `inFlight ≥ cap` (4 texto,
   1 imagen — la difusión ocupa el proceso entero). Si todos los forges
   vivos del modelo están saturados → `429 busy` honesto antes de abrir
   stream, no un request encolado eterno. Saturado ≠ muerto: es candidato
   de último recurso vía `queueMs` inflado, y la UI lo muestra `BUSY`.
6. **Sin candidatos del modelo → throw explícito.** `select()` ya no cae a
   la fleet completa: `scheduler: sin forges para <model>`.

## Consecuencias

- La red ahora balancea carga de verdad: 10 requests concurrentes no van
  todos al forge de mejor TTFT — su `queueMs` crece y el segundo gana.
- Un forge que falla exec (probe vivo) deja de cobrar un intento por
  request después del tercer fallo.
- Toda métrica de routing es medida o declarada explícita: `rttMs` sigue
  siendo constante declarada (localhost); el resto sale de telemetría o de
  contadores en vivo.
- Pendiente declarado: registry firmado por heartbeats (forges remotos con
  capacidad autoreportada) y separación de dominios de confianza — hoy el
  gateway firma proofs con `WORKER_SECRET` y paga con `SETTLEMENT_SECRET`
  en el mismo proceso. Proof L0 es auto-certificación honesta para demo,
  no la garantía del paper.
