# ADR 0006 — Settlement hardening: proof=trabajo servido, pago garantizado

Fecha: 2026-09-22 · Estado: aceptado

## Contexto

La auditoría del pipeline de pago (post ADR-0005) encontró que la cadena
identidad→proof→payout era conceptualmente cerrada pero tenía agujeros
concretos: el gateway verificaba la firma del hash declarado sin recomputar
el hash del output servido; el dedup por idempotency-key podía suprimir
pagos a forges distintos; un crash entre `fund_job` y `release` dejaba
plata huérfana sin referencia; el forge no podía cobrar sin la buena
voluntad del operador; el payout era flat sin metering; y settles
concurrentes competían por el sequence number de la cuenta operadora.

## Invariantes de pago

- **I1**: proof válido ⟺ `sha256(bytes servidos al cliente) == resultHash`
  ∧ firma ed25519 verifica contra la key registrada del forge. El gateway
  recomputa sobre los chunks que relayeó — jamás confía en el hash
  declarado por el daemon.
- **I2**: cada job servido paga a su forge exactamente una vez. El dedup
  es por *resultado* (`idemKey:resultHash`), no por request: un retry que
  re-ejecuta y produce otro output paga al forge que lo sirvió.
- **I3**: plata fondeada jamás queda huérfana — `SettleJournal` persiste
  `{jobId, worker, hash, sig, fundTx}` apenas vuelve `fund_job`; boot
  sweep re-intenta `release` o hace `refund` al operador.
- **I4**: el forge puede cobrar sin el operador — `fund_job` liga el job
  al worker al fondear; `release` acepta `caller ∈ {admin, job.worker}`.
- **I5**: pago ∝ trabajo medido — `payout = base + genTokens × perToken`,
  techo `PAYOUT_MAX`. `genTokens` es medido (frame done del engine), no
  declarado.

## Cambios por invariante

### I1 — binding hash↔output (`forge-net/remote.ts`)

`RemoteForgeExec` hashea cada token que entrega al consumidor; al
`job.done` compara con el `resultHash` declarado. Mismatch → el stream
falla (`proof hash mismatch`): el cliente ve corte honesto, no se emite
`onProof` (no hay settle) y el breaker cuenta el fallo vía `onFail`.
El daemon honesto ya firma `sha256(output)` — comportamiento idéntico.

### I2 — dedup por resultado (`gateway/index.ts`)

`settleOnce` key = `idemKey:resultHash.hex`. Dos ejecuciones distintas
(dos outputs, quizá dos forges) producen dos settles — correcto: el
trabajo fue real dos veces. Un retry que reproduce el mismo proof dedup.

### I3 — journal durable (`settlement`, `db` migration 0005)

`EscrowSettlement` acepta `journal?: SettleJournal` — record post-fund,
markReleased post-release. `serve.ts` barre `pending()` al boot:
re-release (el proof sigue válido) o refund si el forge ya no existe.
InMemory en dev, Postgres en prod.

### I4 — self-claim (`contracts/weaver-escrow` v4 final)

`fund_job(client, amount, worker)` liga el job al worker al fondear
(fail-fast `ForgeNotFound` si no está registrado — no se fondea lo
incobrable). `release(caller, job_id, hash, sig)`: caller ∈
{admin, job.worker}. El admin liquida en el flujo normal post-serve;
el worker tiene fallback si el operador desaparece o se niega.

El loop se cierra por WS: si el `release` del operador falla post-fund,
`EscrowSettlement.onPending` emite `job.funded {chainJobId, resultHash}`
a la sesión del forge; el daemon re-firma el hash y llama `release` como
caller=worker (`Claimer` seam; `weaver-forge up --contract` lo habilita).
BadState en el claim = el sweep ya lo pagó → se ignora. Además existe el
escape hatch manual `weaver-forge claim --job N --hash HEX --sig HEX`.

### Sweep transitorio vs terminal (`settlement/escrow.ts`)

`sweepPendingSettles` solo marca `failed` ante errores TERMINALES del
contrato (`isTerminalReleaseError`: BadState/Unauthorized/ForgeNotFound/
…). Un timeout de RPC o sequence mismatch deja el row `pending` —
reintentable en el próximo boot. Antes, cualquier error era terminal y
sacaba el escrow del recovery para siempre.

### Operador derivado + registro al boot (`gateway/serve.ts`)

`operator` deriva de `SETTLEMENT_SECRET` (`stellarPubkey`) — un G...
hardcodeado desalineado dejaba toda tx sin auth. `SETTLEMENT_CONTRACT`
es obligatorio cuando settlement está ON (sin default: un contractId
stale de ABI vieja rompe cada settle silenciosamente). Al boot el
gateway self-registra el worker fallback (embedded → el operador mismo)
porque `fund_job` a forge no registrado revierte.

### I5 — metering (`settlement/payoutFor`)

`payoutFor({genTokens}, cfg)` pura; `settleJob` acepta amount explícito.
Env: `PAYOUT_BASE` (default 100000 = $0.01) / `PAYOUT_PER_TOKEN`.

### P7 — submitter serializado

`RpcSubmitter.invoke` corre por una queue interna: una tx en vuelo por
cuenta — elimina la contienda de sequence number bajo settles
concurrentes.

### I6 — ventana de claim (S43, contrato v4+claim-window)

`Job.funded_at` + `CLAIM_WINDOW_SECS = 86400`: `refund` revierte con
`TooEarly` dentro de las primeras 24h — el operador ya no puede retirar
el escrow antes de que el forge haya podido self-claimear. Pasada la
ventana, refund recupera plata de jobs que el worker nunca claimeó.
`release` del worker sigue abierto incluso tras la ventana (la ventana
bloquea el retiro, no el cobro).

### Anti-colusión en audits (S45)

La referencia del replay debe ser de OTRO operador: embedded (sin pubkey)
o remoto con `forgePubkey` distinto al target. Si todo el fleet del
modelo comparte pubkey → `skipped` honesto (un audit sin referencia
independiente no prueba nada).

### Strikes persistidos (S46)

`forges.strikes` (migration 0006) + `ForgeStore.addStrike/resetStrikes`
por pubkey — los strikes sobreviven al restart del gateway y no se pueden
resetear renombrando instanceIds (la clave es la identidad, no el slot).

## Deuda residual declarada

- **Cobertura de audit depende del fleet**: un modelo servido por UN solo
  operador nunca tiene referencia independiente → audits siempre skipped
  para él. La red necesita diversidad real de operadores por modelo.
- ~~Rate-limit de heartbeats~~ **resuelto** (S49): `ForgeSession` droppea
  heartbeats <500ms y mata la sesión a la 5ª violación consecutiva —
  `job.*`/`pong` no limitados (bursts legítimos).
- **Deploy v5 pendiente**: testnet corre v3 (clave global, sin upgrade).
  Runbook abajo. Desde v5 el contrato incluye `upgrade(new_wasm_hash)`
  admin-gated (S51): fixes futuros van in-place sin redeploy ni
  re-registro — trade-off aceptado: el admin ya controla release+refund,
  y la alternativa (redeploy + re-registro global por fix) era peor.
- ~~genTokens declarado~~ **resuelto**: `RemoteForgeExec` sobrescribe
  `stats.genTokens` con el conteo de chunks que relayeó al cliente —
  medido gateway-side y atado al hash verificado (chunk ≈ token del
  engine stream; aproximación honesta, no inflable por el forge).

## Runbook de deploy v5

```bash
cd contracts/weaver-escrow
stellar contract build
stellar contract deploy --wasm target/wasm32v1-none/release/weaver_escrow.wasm \
  --source $ADMIN_SECRET --network testnet
stellar contract invoke --id $NEW_CONTRACT --source $ADMIN_SECRET --network testnet \
  -- init --admin $ADMIN_G --token $USDC_SAC
# cada forge (self-service):
weaver-forge register --contract $NEW_CONTRACT
# gateway: apuntar SETTLEMENT_CONTRACT=$NEW_CONTRACT y reiniciar
```
