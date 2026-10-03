# TASKS-GEMINI — paquete de docs Metropolis (delegación paralela)

> **Para el agente que toma esto:** trabajás en el worktree
> `../weaver-gemini` (branch `gemini/metropolis-pack`), NUNCA en `main/`.
> Un commit por tarea (`docs(gemini): T<N> <título>`). Cuando termines una,
> marcala `[x]` acá con el hash del commit.
>
> **Líneas rojas (si las tocás se rompe el merge):**
> - NO edites `apps/`, `packages/`, `contracts/` (código), `README.md`,
>   `CONTEXT.md`, `AGENT.md`, ni `docs/metropolis/{README,roadmap,plan}.md`.
> - Solo archivos de este documento. Leé todo el resto libremente.
> - Nada inventado: cada dirección/tx/agentId sale de los datos de acá abajo
>   o de archivos del repo. Si un dato no existe, decí "no verificado".
> - Español para docs internos; inglés para lo que va al formulario (T2, T4).
> - No corras `git push`, `git merge`, ni comandos destructivos.

## Datos canónicos (los únicos que valen)

- **Producto:** Weaver — red de inferencia distribuida. Scheduler por ETR
  medido, failover, proof L0 (hash del resultado firmado por el forge),
  escrow por job, ZDR (prompts en RAM), identidad+reputación ERC-8004.
- **Chain:** Monad testnet, chain id `10143`, RPC `https://testnet-rpc.monad.xyz`,
  explorer `https://testnet.monadvision.com` (tx: `/tx/<hash>`, addr: `/address/<addr>`).
- **Contratos propios** (`contracts/weaver-escrow-evm/deployments/testnet.json`
  es la fuente de verdad completa — leé ese archivo):
  - `WeaverEscrow` `0x51acE4858652D942dC7b320870e4CDbc5c989cD6` (Sourcify ✓)
  - `WeaverCredits` `0xd14957AE85C4FA10fd5AB9f0d17f1cFcE2C0A498` (Sourcify ✓)
  - USDC testnet `0x534b2f3A21130d7a60830c2Df862319e593943A3`
  - ERC-8004 Identity `0x8004A818BFB912233c491871b3d84c89A494BD9e`
  - ERC-8004 Reputation `0x8004B663056A597Dffe9eCcC1965A193B7388713`
- **Live E2E probado (real, on-chain):** forge remoto `0x784E0a01c683df116fA5bb5A91180d6Fc06BF5CB`
  (`weaver-forge up --chain evm`) → attestation con proof secp256k1 →
  job `qwen3:4b` → `fundJob` `0xd8393adb…` + `release` `0xf06bff16…`
  (`Released(jobId=2)` + Transfer 0.01 USDC al forge) → `giveFeedback`
  agent **1991** `0xae89a2f0…`. Trail completo en el JSON.
- **Semántica del proof:** el forge firma `personal_sign(resultHash)` (32b,
  `r‖s‖v` 65 bytes) AL SERVIR — antes de que exista el jobId on-chain.
  `release` hace ecrecover contra el signer registrado del worker.
- **Auth:** handshake WS — `personal_sign(nonce)` para EVM, ed25519 para
  Stellar; el gateway elige por formato de pubkey (fleet mixta).
- **ERC-8004 flow:** el forge `register()` su propio agente al boot
  (owner = su wallet; agentId en config) → gateway emite `giveFeedback`
  post-release con evidencia `{jobId, fundTx, releaseTx, resultHash}`,
  tag `jobSettled` (operator firma — el registry rechaza self-feedback).
- **x402 v2:** facilitator canónico `https://x402-facilitator.molandak.org`,
  network `eip155:10143`, `EvmFacilitatorVerifier` decodifica el header
  base64 → `paymentPayload` objeto → `/verify`+`/settle`.
- **Depósitos:** `WeaverCredits.deposit(bytes32 acct_…)` → evento
  `Deposited` → `EvmDepositWatcher` (eth_getLogs, idempotente `dep:tx:idx`).
- **Switch:** `SETTLE_CHAIN=evm|stellar` — Stellar/Soroban sigue funcionando
  como adapter previo (tag `stellar-submission` marca el pre-window).

## T1 · `docs/demo-guion.md` — REWRITE (guion del video ≤3 min)

El archivo actual es 100% Stellar (stellar.expert, Soroban, ed25519).
Reescribirlo completo para Monad manteniendo la estructura (checklist de
grabación, beats con ES+EN, plan B, post, fuentes):

- Beats nuevos: hook → RUN en `/network` (pipeline FIRE→ROUTE→EXECUTE→SETTLE)
  → **failover en vivo** (kill_forge) → **on-chain real**: forge remoto
  `0x784E…` sirve el job → fund/release en MonadVision → **ERC-8004**:
  `giveFeedback` `0xae89a2f0…` + agent 1991 → cierre ZDR.
- Links reales del live_e2e del JSON (no inventes otros).
- Mantener la sección "El rival es el peaje" y las fuentes tal cual
  (siguen vigentes) — solo actualiza lo que menciona Stellar.
- Checklist actualizado: `weaver-forge up --chain evm --contract`, gateway
  con `SETTLE_CHAIN=evm REMOTE_ONLY=1 SETTLEMENT_SECRET SETTLEMENT_CONTRACT
  ERC8004_AGENTS`, `pnpm --filter @weaver/web dev`.

## T2 · `docs/metropolis/submission-writeup.md` — NUEVO (inglés)

Texto listo para pegar en el formulario Devfolio. Estructura:

1. **TL;DR** (2 líneas): what Weaver is + the measured-trust thesis.
2. **Problem:** inference gateways = toll booths (evidencia: cita
   `docs/competidores-evidencia.md`, no re-escribas los números).
3. **What we built:** distributed inference on Monad — numbered list del
   loop live (request → attested forge → proof → escrow release → ERC-8004).
4. **Monad integration (20% del judging):** tabla — qué usamos de Monad
   (EVM escrow+credits propios, USDC oficial, ERC-8004 singletons,
   x402 facilitator canónico, sub-second finality) y POR QUÉ cada pieza.
5. **ERC-8004 usage:** cómo implementamos el pedido literal del track 04 —
   forge self-registers, feedback con evidencia de settle, attestation como
   capa de validación (ValidationRegistry no existe aún en testnet — decirlo).
6. **Deliverables:** links — repo, contratos (verificados), txs live,
   video (placeholder), docs.
7. **Pre-existing vs new:** copy corto del §Metropolis submission del README.
8. **What's next / honest limitations:** feedback 1tx/job (batched en
   prod), testnet-only, ValidationRegistry pendiente upstream.

Tono: directo, sin hype, datos verificables. Máx ~900 palabras.

## T3 · `docs/adr/0009-evm-trust-layer.md` — NUEVO

ADR de implementación (complementa 0008 que fue la DECISIÓN; este registra
lo que efectivamente se construyó). Mirá `docs/adr/` para el formato.
Decisiones a documentar con contexto+alternativas:

- Firma = `personal_sign(resultHash)` y NO `resultHash‖jobId` (el forge
  firma al servir; el v1 deploy `0x743C…` quedó como lección — está en el
  JSON `previous`).
- Forge self-registra su agente ERC-8004 (identidad portable, no
  plataformizada) vs platform-registers (más fácil pero deshonesto).
- Feedback por operator (self-feedback prohibido por el registry).
- Verify dual por formato de pubkey (0x/G) vs flag de chain por config.
- `eth_getLogs` paginado ≤100 bloques vs `watchEvent` (límite real del RPC).
- x402: wire canónico directo al facilitator vs SDK `@x402/evm`
  (misma superficie, menos deps).
- Worker EVM = una sola key para auth+proof+payout (UX de un solo signer)
  + separación opcional `registerForge(signer)` ya soportada en contrato.

## T4 · `docs/metropolis/bounties.md` — NUEVO (inglés)

Por cada bounty alcanzable: qué pide, qué tenemos hoy que mapea, qué
faltaría, esfuerzo honesto (S/M/L), y si vale la pena antes del deadline.
Base: `docs/metropolis/README.md` §Bounties. Bounties: Mera passkey×2,
MetaMask Delegation (forge = agent wallet ya firma proofs — buen ángulo),
Envio indexer (`Deposited`/`Released`/`NewFeedback` → dashboard), Alchemy
credits (trivial). Conclusión: priorizar track 04; bounty que sea "free"
por trabajo ya hecho → aplicar; el resto post-deadline.

## T5 · `docs/pitch-guion.md` — REFRESH

El guion del deck menciona Stellar/escrow Soroban/stellar.expert.
Actualizarlo a Monad + ERC-8004 manteniendo beats y timing (misma función:
pitch de 11 slides). Links nuevos del JSON.

## T6 · `docs/launch/launch-copy-monad.md` — NUEVO

Copy de re-render del spot 30s (`weaver-launch.mp4`, hecho con copy Stellar).
Leé `docs/launch/index.html` para ver la estructura de escenas/lower-thirds
actuales y escribí el guion escena-por-escena con texto nuevo: Stellar→Monad,
agregar ERC-8004 beat (agent identity on-chain) y el CTA a track 04.
Mantener duraciones (es para re-render determinista del mismo archivo —
NO edites `index.html`, solo escribí el guion nuevo).

## Hecho = checklist por tarea

- [x] T1 demo-guion reescrito (Monad + live txs) · commit: 9edecb2
- [x] T2 submission-writeup.md · commit: 841958b
- [x] T3 ADR-0009 · commit: dc1051a
- [x] T4 bounties.md · commit: 71cffa1
- [x] T5 pitch-guion actualizado · commit: c0917f7
- [x] T6 launch-copy-monad.md · commit: 7a64199

> El humano (Devin en `main/`) se queda con: video re-render
> (`docs/launch/index.html`), x402 live payload, deploy, push, y merge
> de esta branch cuando termines. No toques nada de eso.
