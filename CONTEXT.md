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

### Lado del consumidor (ADR-0007)

- **Account:** identidad anónima del usuario (`acct_…`). Se crea con un POST, sin email/password. La prueba de posesión ES el token: `wvr_acct_` (management, una vez) o `wvr_sess_` (sesión por firma wallet).
- **API key:** credencial `wvr_` que el usuario mete en clientes OpenAI-compatibles. `owner = acct_…` la ata a su Account: cada Job con esa key debita su balance.
- **CreditLedger:** contabilidad append-only en stroops (`topup` + / `debit` −). Balance = suma. `debit` exige uso medido del stream servido; `topup` exige pago on-chain deduplicado.
- **Deposit memo:** el memo text de un pago clásico Stellar que identifica la Account a acreditar (= `accountId` o wallet linkeada). Solo pagos clásicos llevan memo — un SAC invoke no.
- **DepositWatcher:** observador que pollea Horizon y convierte pagos con memo válido en `topup`s del ledger. Idempotente por operation id.
- **402 (billing gate):** la respuesta cuando una key con Account no tiene balance ≥ costo mínimo — se decide ANTES de tocar un Forge. Un stream ya servido termina y debita igual (no se corta mid-flight).
- **Catalog:** vista marketplace de modelos = metadata declarada por el operador + fleet viva + pricing + telemetría medida. Regla de oro: lo no declarado sale "not declared", lo no medido sale nulo — jamás inventado.
