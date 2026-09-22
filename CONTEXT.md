# Weaver — CONTEXT.md (glosario, nada de implementación)

> Fuente de verdad del lenguaje. Si el código dice otra cosa, se cambia el código o se discute acá. Sin detalles de infra.

- **Job:** pedido de un usuario/agente por un modelo + input. No es un Request HTTP.
- **Forge:** rol económico que ejecuta cómputo (CPU/GPU/API). No es Host ni Node.
- **ModelInstance:** par Forge + modelo, con estado HOT/COLD, load_time, precio.
- **Capability:** modalidad que un Forge sirve (`text` | `image`). Determina qué Jobs puede tomar: un Forge de imagen nunca recibe chat, uno de texto nunca recibe generación. Ausente = `text`.
- **Execution:** un Job corrido en un Forge, con `result_hash` + proof.
- **Proof L0:** receipt firmado por el Forge (rápido, sin redundancia).
- **Proof L1:** ejecución redundante en 2 Forges sobre benchmark determinístico, se compara hash normalizado.
- **Settlement:** consecuencia económica en Stellar. No es el cobro x402 en sí.
- **ETR (Expected Time to Result):** `RTT + queue + load_si_COLD + prefill + gen + verify`. Única métrica de routing. `queue` e `inFlight` se miden (TrackedExec); `gen` usa `estOutTokens / tokPerSec` medido cuando el Job declara tamaño.
- **HOT:** ModelInstance con pesos ya en memoria, `load_time = 0`.
- **COLD:** ModelInstance que paga `load_time` antes de generar.
- **Saturated:** Forge vivo que llegó a su cap de jobs concurrentes. ≠ DEAD: sigue siendo candidato pero la red prefiere otro; si TODOS los vivos están saturados → `429`.
- **Circuit breaker:** ≥3 fallos de Execution en 60s → Forge fuera de rotación 30s. Un éxito resetea. Distinto de muerte por probe: mide intentos reales, no liveness.
- **ForgeIdentity:** keypair Stellar ed25519 del Forge. El pubkey es identidad (firma proofs y handshakes) Y payout address (el escrow le paga a él). No hay cuentas con password.
- **Remote forge:** Forge como proceso separado que marca outbound al gateway por WebSocket (modelo mining-pool: heartbeats suben, Jobs bajan). El daemon vive en `apps/forge`.
- **Heartbeat:** mensaje firmado del Remote forge cada ~5s con capacidad real por ModelInstance (modelo, capability, hot, inFlight, tokPerSec, loadTime). Sin heartbeat en ~15s → el Forge expira del registry. La telemetría ES el protocolo.
- **Attestation:** al registrarse, cada ModelInstance ejecuta un benchmark determinístico (prompt + temp0 + seed) y el gateway compara el hash contra el catálogo. `attested:false` → registrado pero no ruteable. La capacidad se prueba, no se declara.
- **Registry:** estado vivo de forges remotos (in-memory, TTL por heartbeat) + tabla `forges` para identidades. El ForgeView deja de ser constante: nace del último heartbeat.
- **Take:** comisión Weaver (5–15% según §19 del paper).
