# Roadmap Metropolis — 11 días al deadline (2 → 13 Oct)

> Scope defendible: lo mínimo que demuestra la tesis on-chain sobre Monad.
> Regla: si una fila no aporta a **trust medido on-chain** o al demo, sale.
>
> De-risk post-research: **solo 2 contratos propios** (escrow + credits).
> ERC-8004, x402 y USDC ya existen como infra canónica en Monad testnet.

## Semana 1 — el port (2 → 8 Oct)

**D0 · 2 Oct (hoy)**
- [x] Investigación + ADR-0008 + este plan + tag `stellar-submission` + `LICENSE` MIT
- [x] Foundry 1.8.4 instalado (official; `network="monad"` va en foundry.toml por proyecto)
- [x] Registro en hackathon.monad.xyz (admin del equipo) ✓
- [x] MON de `faucet.monad.xyz` + USDC testnet de `faucet.circle.com` (`0x534b…43A3`)
  en la wallet operadora ✓

**D1 · 3 Oct** *(activación Buenos Aires — ir, hablar con mentores)*
- [x] `contracts/weaver-escrow-evm/` — `forge init --template monad-developers/foundry-monad` ✓
- [x] `WeaverEscrow.sol`: port de `lib.rs` (init/registerForge/fundJob/release/
  refund/getJob + eventos `Funded/Released/Refunded`) ✓
- [x] ecrecover del proof L0: personal-sign sobre `resultHash` (32b) —
  fiel al Soroban (el forge firma al servir, sin conocer jobId) ✓
- [x] Tests Foundry (mismos casos que el Soroban) — **18/18 verdes** ✓
- [x] Deploy + Sourcify + **flow live**: registerForge→approve→fundJob→release
  con proof real on-chain (ver `contracts/weaver-escrow-evm/README.md`) ✓

**D2 · 4 Oct** *(adelantado al 3 Oct)*
- [x] `WeaverCredits.sol`: `deposit(bytes32 account)` + evento `Deposited` ✓
- [x] `packages/settlement/src/evm.ts`: `EvmSubmitter` (viem, simulate→write→
  receipt, SerialQueue), `EvmEscrowSettlement`, `evmSigner/evmVerify` ✓
- [x] `erc8004.ts`: `registerAgent`/`giveFeedback`/`forgeAgentURI` contra los
  singletons canónicos — **live verificado**: agentId 1990 + NewFeedback ✓
- [x] env switch `SETTLE_CHAIN=evm|stellar` en el gateway — verify dual por
  formato de pubkey (`0x…`→ecrecover, `G…`→ed25519): fleet mixta coexistiendo ✓

**D3 · 5 Oct**
- [x] Forge identity EVM: handshake del daemon firma con secp256k1
  (personal_sign del nonce); `forge-net` verify async dual ed25519/ecrecover ✓
- [x] `weaver-forge init --chain evm`: keypair secp256k1, `pubkey`=address 0x,
  config 0600 — mismo key para auth + proofs + payout ✓
- [x] `registerForge` onchain: `weaver-forge register` / `up --contract` —
  el forge self-registra su proof signer (msg.sender=worker) ✓

**D4 · 6 Oct**
- [x] x402 v2 canónico: `EvmFacilitatorVerifier` — decodifica el header
  base64 → `paymentPayload` objeto, `/verify`+`/settle` contra
  `x402-facilitator.molandak.org` (verificado live hasta ECRecover en
  la simulación on-chain: schema correcto) + requirements EVM en el 402
  (`eip155:10143`, USDC `0x534b…43A3`, extra name/version). Sin `@x402/evm`:
  wire canónico directo, misma superficie ✓
- [x] `EvmDepositWatcher` (`packages/accounts`): `eth_getLogs` de
  `Deposited(bytes32 acct_…)` → CreditLedger idempotente
  (`dep:<tx>:<idx>`). `getLogs` en vez de `watchEvent`: el RPC de Monad
  limita a 100 bloques/página ✓

**D5 · 7 Oct**
- [x] ERC-8004 al boot: `weaver-forge up` self-registra su agente si no tiene
  `agentId` en config (data:URI, owner = forge wallet) y lo persiste ✓
- [x] Gateway: `giveFeedback` post-release vía `ERC8004_AGENTS` — evidencia
  = jobId+fundTx+releaseTx+resultHash, tag `jobSettled` (el operator firma:
  el registry rechaza self-feedback) ✓
- [x] `GET /v1/forges` expone `forgeAgentId` (fluye por heartbeat) ✓

**D6 · 8 Oct**
- [x] End-to-end live: forge remoto real (`weaver-forge up --chain evm`) →
  attestation con proof secp256k1 → job qwen3:4b → ecrecover → fundJob+
  release (0.01 USDC al forge `0x784E…`) → `giveFeedback` agent 1991 —
  trail en `contracts/weaver-escrow-evm/deployments/testnet.json` ✓
- [ ] Deploy gateway con `SETTLE_CHAIN=evm` (Railway)
- [x] Web dual-chain: `EXPLORERS{stellar,evm}` + links por formato de hash,
  `/network` badge MONAD TESTNET, ProofSection al explorer del deploy,
  BillingTab `dep:0x…` → MonadVision; copy Stellar→Monad ✓

## Semana 2 — el paquete (9 → 13 Oct)

**D7 · 9 Oct**
- [ ] Demo real: failover en vivo + release + feedback, capturado
- [ ] Write-up de submission (problem/approach/ERC-8004/deliverables)
- [ ] README §submission: pre-existente (`stellar-submission` tag) vs nuevo
  del window + disclosure AI tools + addresses de contratos

**D8 · 10 Oct**
- [ ] Video demo **≤3 min** (§9.4): producto operando + on-chain visible;
  spot 30s re-render con copy Monad como intro + captura live
  (failover → release → monadscan → 8004 explorer)
- [ ] Buffer de bugs

**D9 · 11 Oct**
- [ ] Submission en Devfolio: video, write-up, repo, links de contratos
- [ ] Bounty applications: Mera, MetaMask Delegation, Envio, Alchemy

**D10 · 12 Oct**
- [ ] (Stretch) `acct_` → Mera passkey → EOA (bounty Mera ×2)
- [ ] (Stretch) Envio indexer escrow+reputation → dashboard live
- [ ] (Stretch) MetaMask delegation: presupuesto acotado → agente Weaver

**D11 · 13 Oct**
- [ ] SUBMIT. Nada nuevo hoy — solo fixes del formulario.

## Fuera de scope (dilo vos primero o lo dirán los jueces)

- Training federado, multi-region scheduler, L1 re-exec en producción
  (lo dejamos como attestation+benchmarks por forge)
- Mainnet deploy — testnet es suficiente para la demo on-chain
- ValidationRegistry — no existe aún en Monad testnet; nuestra attestation
  cubre la capa de validación
- Feedback batched para producción — hoy es 1 tx/job, ok a volumen demo
