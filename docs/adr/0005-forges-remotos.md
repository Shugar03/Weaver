# ADR 0005 — Forges remotos: identidad, transporte, registry, attestation y payout

Fecha: 2026-09-22 · Estado: aceptado

## Contexto

Hasta acá los forges eran constantes en `serve.ts` + execs in-process. La
identidad era `WORKER_SECRET` dentro del gateway — el operador firmaba proofs
y se pagaba a sí mismo (auto-certificación honesta para demo, pero no es la
red). No existía: cuenta de operador, registro, forge remoto, payout
per-forge, ni forma de que una PC real se sume a computar.

## Decisión

### Identidad: un Forge ES una keypair Stellar

No hay cuentas con email/password. `weaver forge init` genera una keypair
ed25519 en `~/.weaver/forge.json` (chmod 600); el secreto jamás sale de la
máquina. El pubkey `G...` es a la vez: identidad (firma proofs L0 y el
handshake), y payout address (el `release` del escrow le paga a él — el
contrato ya aceptaba `worker` por parámetro).

Registro = challenge-response: `POST /v1/forges/challenge` emite nonce
single-use (TTL 60s); el forge lo firma y lo manda como primer mensaje del
WS (`auth`). El gateway verifica con `stellarVerify` y registra la sesión
bajo ese pubkey. Segunda conexión con el mismo pubkey → kick del anterior
(la máquina reintenta tras un crash).

### Transporte: WebSocket outbound persistente

El forge **marca hacia afuera** al gateway (`/v1/forge/ws`) — NAT-friendly,
sin puertos inbound en la PC del operador. Es el modelo mining-pool
(stratum): el canal autenticado sirve doble — heartbeats suben, jobs bajan.
Push (no polling): asignación sin latencia extra sobre el TTFT.

El seam es `RemoteForgeExec implements ForgeExec` /
`RemoteImageExec implements ImageExec`: el transporte es un adapter más.
`RoutedExec`, failover, breaker, `TrackedExec`, admission control y ETR
size-aware funcionan sin cambios — la carga viaja en heartbeats en vez de
contadores locales.

### Registry: el ForgeView nace del heartbeat, no de constantes

`ForgeRegistry` (in-memory: un forge solo "existe" mientras está conectado)
guarda por pubkey la lista de `ModelInstance`s declaradas y su último
heartbeat. Cada instance produce un `ForgeView` (`forgeId` = instanceId
único, `forgePubkey` = owner, `hot`, `inFlight`, `tokPerSec`, `loadTimeMs`,
`capability`, `attested`). TTL ~15s: sin heartbeat, el forge expira y sale
de rotación — la muerte por desconexión es el default, no una excepción.

Identidades persisten en tabla `forges` (pubkey, displayName, attested,
createdAt, lastSeen) vía puerto `ForgeStore` (InMemory + Postgres).

Los forges embebidos quedan detrás de `EMBEDDED_FORGES` (default on en dev):
el demo sigue andando y los tests existentes no se rompen.

### Attestation: la capacidad se prueba, no se declara

Implementado (S35): al aparecer una instance en el heartbeat, el gateway le
corre un job real chico (`"Reply with exactly: ok"`, `temp:0`, 4 tokens) por
el canal. La instance pasa si emite tokens Y el proof L0 verifica con
`stellarVerify` contra el pubkey registrado — prueba que **ejecuta un engine
real y posee la key**. Sin attestation la instance aparece en `/v1/forges`
con `attested:false` pero el routing la excluye (`f.attested !== false` en
chat e imagen). En UI: badge `RMT` (gris) → `RMT ✓` (lima) al attestar.

Decisión honesta respecto del diseño original: NO comparamos hash esperado —
el output de un LLM no es determinista cross-engine (versión de Ollama,
sampler, backend). La firma sí es verificable siempre. La mentira de modelo
("digo qwen3 pero corro algo más barato") la cubren los audits, no el
attestation. Attestation de imagen (S40): `image.assign` real sobre el canal
+ validación estructural del resultado (`imageDims`: PNG IHDR / JPEG SOF /
WebP VP8X — la imagen debe decodificar con dimensiones; el contenido no es
determinista y eso se declara). La misma validación corre sobre CADA
`image.result` remoto en la ruta — basura → 502 + breaker.

Post-registro: `reliability` medida (S36) + **audit replay** (S38): con
probabilidad `AUDIT_RATE` (default 5%) tras un job OK de un remoto, el
`Auditor` re-ejecuta el prompt canónico (temp 0, 16 tok) en ese forge Y en
una referencia del mismo modelo (embedded preferida). Hash distinto =
strike; 2 strikes seguidos → `breaker.fail` (el falso positivo cross-engine
existe: son strikes, no ban inmediato). Auditor caído o sin referencia =
skip — jamás penaliza al forge por una falla del propio auditor.

**Verificación por-job (S37)**: todo proof de forge remoto se verifica con
`stellarVerify` contra el pubkey del registry ANTES de settle — haya o no
settlement configurado. Firma inválida → `breaker.fail` + sample
`settle:failed`; el cliente ya recibió su stream (el daño pasó), pero no se
paga y el forge sale de routing.

### Payout per-forge

`settleJob(resultHash, forgeSig, workerAddr)`: el gateway resuelve
`workerAddr` del registry por `forgeId` (remote) o `WORKER_PUBKEY` env
(embedded). Idempotency-Key incluye el worker. El proof que firma el forge
con SU key es lo que libera el pago a SU address — consistente por diseño.

**Contrato v4 (S41)**: `DataKey::Forge(Address) → BytesN<32>` reemplaza la
clave global `Worker` de v3. `register_forge(worker, pubkey)` es
self-service — `worker.require_auth()` prueba la address de payout, y la
pubkey puede ser OTRA clave (hot key del daemon firma, cold wallet cobra).
`release` verifica la firma contra la pubkey de ESE worker: un proof del
forge A no paga un job del forge B; worker desconocido → `ForgeNotFound`.
Re-registro rota la clave. Deploy a testnet pendiente (queda del operador —
el contract_id actual corre v3).

### Rig: forge = máquina, N instances

Un rig es un forge (1 pubkey, 1 payout) que anuncia N `ModelInstance`s en
su heartbeat — multi-GPU o multi-modelo. El daemon toma `instances[]` en
config + budgets **implementados** (S39): `idleOnly` (gate de idle-time del
OS vía `osIdleMs` — probe no disponible = conservador: saturated) y
`maxVramGb` (`ollamaVramUsedGb` desde `/api/ps`; instance COLD solo se
ofrece si `vramUsada + footprint` entra — la HOT ya pagó su VRAM, se
reporta igual). Budget no es invisibilidad: la instance se reporta con
`saturated:true`, sale de routing sin fingir muerte. `vramGb` se auto-llena
desde `/api/tags` size en `init`. Modo oportunista (BOINC): idle → carga
modelo → HOT → jobs; usuario vuelve → termina el job en curso, reporta
saturated, descarga. La red tolera la oscilación HOT↔COLD por diseño: el
scheduler ya cobra `loadTimeMs`.

## Consecuencias

- El gateway deja de ejecutar: se vuelve router + verifier + settler.
  `WORKER_SECRET` embebido queda solo para forges embebidos (dev/demo).
- Nada puede cobrar sin proof firmado por el pubkey que recibe el pago —
  la cadena identidad→proof→payout es cerrada.
- Los campos medidos de S27–S29 (`inFlight`, `saturated`, `tokPerSec`) se
  convierten en el schema del heartbeat: la telemetría ES el protocolo.
- **Deuda declarada (fuera de scope)**: stake/slashing, web operator
  accounts (agregación de N forges bajo una cuenta), discovery
  descentralizado, rate-limit de heartbeats por pubkey, deploy del
  contrato v4 a testnet (código + tests listos; el contract_id desplegado
  corre v3 con clave global), Playwright e2e de UI (la cobertura e2e hoy
  es `apps/forge/scripts/smoke.mjs`: challenge→auth→heartbeat→job→SSE).
