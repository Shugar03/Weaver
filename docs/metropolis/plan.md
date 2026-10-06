# Plan Metropolis — Weaver × Monad (nivel DIOS)

> Estrategia maestra para Metropolis · deadline 13 Oct · track 04.
> Operación día a día en `roadmap.md` · decisión técnica en `../adr/0008`.

## 0. La misión en una línea

**Weaver convierte forges en agentes económicos verificables**: identidad
ERC-8004, reputación medida (ETR real, no declarada), liquidación por job en
escrow on-chain — el stack completo de agent-trust que el track 04 pide,
funcionando end-to-end, no un diagrama.

### Lo que el juez ve en 90 segundos

1. Un request entra → el scheduler elige el forge por **ETR medido**.
2. El forge muere a propósito → **failover en vivo**, el stream no se corta.
3. El job termina → `release()` en el escrow, **verificable en monadscan**.
4. El gateway postea `giveFeedback` → el forge aparece en el
   **8004 explorer** con reputación real.
5. "Nada de esto es declarado — se mide y se liquida."

## 1. Superficie de premios (tracks + bounties)

| Premio | $ | Esfuerzo | Cómo lo ganamos |
|---|---|---|---|
| **Track 04 — Trust, Identity & AI Infra** | $30k (3 equipos) | core | Es el producto: ERC-8004 canónico + attestation + escrow |
| **Grand Champion** | $25k | implícito | Automático si ganamos el track |
| **Monad Foundation — Best Mera-Powered UX** | $2.5k | ½ día | `acct_` → passkey → EOA (Mera): onboarding sin seed phrase |
| **Monad Foundation — Mera: One Passkey, Many Keys** | $2.5k | incluido arriba | Un passkey deriva múltiples EOAs: cuenta + signer |
| **MetaMask — Best Agent Wallet Plugin** | $2.5k | ½–1 día | Delegation Toolkit: usuario delega presupuesto acotado al agente Weaver (caveats: `SpendingLimit` + `ContractTarget` al escrow) |
| **Envio — Best Use of Envio** | $1k | ½ día | Indexer de `Funded/Released/Deposited` + `NewFeedback` → dashboard live |
| **Alchemy — credits** | credits | trivial | Usar Alchemy RPC como RPC secundario + listarlo en submission |
| **Best Community Team Project** | $5k | — | Automático si aplica |
| Chainlink CRE, Kuru, Perpl, Agora… | — | skip | No encajan; perseguirlos diluye. |

**Regla de surface:** cada bounty extra tiene que ser ≤1 día Y reforzar la
narrativa de track 04. Mera y MetaMask sí (identidad/accounts). Envio sí
(observabilidad de trust). El resto no.

## 2. Arquitectura del port — qué se escribe vs qué existe

```
cliente ─x402 (EIP-3009 gasless)→ facilitator Monad ──→ USDC oficial
   │                                                        │
   ▼                                                        ▼
gateway (Hono) ──→ scheduler ETR ──→ forge daemon (secp256k1)
   │                                    │  firma proof L0
   │  registerAgent + giveFeedback      │  ecrecover en escrow
   ▼                                    ▼
ERC-8004 Identity/Rep (singletons)  WeaverEscrow.sol (fund→release)
   ▲                                    ▲
   │                                    │
agent0-sdk                       EvmSubmitter (viem) ── port ChainSubmitter
```

**Escribimos (scope propio):**
- `WeaverEscrow.sol` — port 1:1 del Soroban `lib.rs` + `WeaverCredits.sol`
  (`deposit(bytes32 account)` + evento `Deposited`).
- `EvmSubmitter` / `evmSigner` / `evmVerify` en `packages/settlement`
  (adapter nuevo detrás del port `ChainSubmitter` ya existente).
- Capa de trust: `registerAgent`/`setAgentURI` (registration file data:URI
  on-chain) + `giveFeedback` por ejecución — vía **agent0-sdk** si soporta
  Monad testnet, si no calls directos con viem (ABI chico).
- Identidad secp256k1 en `apps/forge` + `packages/forge-net` (verify handshake).

**Ya existe (integración, cero código propio):**
- ERC-8004 singletons en testnet: Identity `0x8004…BD9e`, Reputation `0x8004…8713`
- USDC oficial `0x534b…43A3` (EIP-3009) + faucet Circle + facilitator x402 v2
- Monad Foundry (`foundryup --network monad`) + template `foundry-monad`
- Mera (passkey→EOA), Delegation Toolkit (bundler Biconomy en testnet),
  Envio (indexa testnet `10143`), viem `monadTestnet` nativo

## 3. Fases

### P0 — Setup (hoy, 2 Oct)
- Tag `stellar-submission` ✓ (auditable diff para el write-up)
- Registro hackathon.monad.xyz · MON + USDC faucets · `foundryup --network monad`
- **Gate:** `cast` llega a testnet-rpc, USDC recibido en wallet de operador.

### P1 — Cadena (D1–D3: 3–5 Oct)
- WeaverEscrow.sol + WeaverCredits.sol, tests Foundry (mismos casos que Soroban),
  deploy + verify en monadscan.
- `EvmSubmitter` + signer ecdsa; daemon firma handshake con secp256k1.
- **KPIs:** `forge test` verde · `release()` on-chain <2s post-job ·
  replay del settle con `SETTLE_CHAIN=stellar` sigue compilando (seam intacto).

### P2 — Trust layer (D4–D5: 6–7 Oct)
- x402 v2 con facilitator Monad (pagar = una firma EIP-3009 del cliente).
- Forge minta agentId + agentURI al boot; gateway postea `giveFeedback` por
  ejecución (value = score(ETR, éxito), tags `weaver:etr` + capability).
- Watcher: `Deposited` events → `topup` del ledger.
- **KPIs:** 100% ejecuciones cerradas emiten feedback tx · cada forge listado
  en `/v1/forges` tiene agentId + link al 8004 explorer · depósito→crédito <5s.

### P3 — Demo & producto (D6–D7: 8–9 Oct)
- Gateway live en Railway con `SETTLE_CHAIN=evm`; web apunta a monadscan;
  dashboard LEDGER muestra: job → proof → release tx → feedback tx.
- **KPIs:** failover visible <5s en demo · loop completo x402→proof→release→
  feedback <90s · zero prompts en calldata/eventos (ZDR on-chain también).

### P4 — Submission (D8–D11: 10–13 Oct)
- Video ≤3 min (regla §9.4): producto operando + on-chain visible; el spot de
  30s re-renderizado con copy Monad sirve de intro, no sustituye el demo real.
- Write-up + README: componentes pre-existentes vs nuevos, disclosure AI tools,
  diff desde `stellar-submission` como evidencia de trabajo del window.
- Bounty apps: Mera → MetaMask → Envio → Alchemy (en ese orden de valor/hora).
- **KPIs:** submit 11 Oct (D9), no 13 — la versión al deadline es la juzgada
  y se puede seguir editando hasta 11:59 PM ET del 13.

### Stretch (solo si P1–P3 cierran antes)
- Mera passkey accounts (bounty $5k total) — consume el cap de 1 día/bounty.
- MetaMask delegation: `Delegation` con `SpendingLimit`+`ContractTarget`
  hacia WeaverEscrow — el agente gasta solo dentro del presupuesto.
- Envio indexer → feed público de trust events.

## 4. KPIs del producto (medibles, no aspiracionales)

### Checklist de submission (reglas oficiales §4.1 — hard requirements)

- [x] Repo público + `LICENSE` MIT + commit history del window
- [x] Tag `stellar-submission` → diff auditable del trabajo nuevo
- [x] README declara explícitamente: componentes pre-existentes vs
  funcionalidad nueva del window + disclosure de AI coding tools
  (`README.md` §Metropolis submission)
- [x] Demo video ≤3 min: producto real operando + interacción on-chain
  Monad visible (release/feedback en explorer) — `docs/demo/weaver-demo.mp4` 2:08
- [x] Docs: descripción + arquitectura + stack + deploy instructions
  (README + `submission-writeup.md` §3-6)
- [x] Contract addresses + tx hashes publicados (writeup §6 + README)
- [ ] Judging = 5×20%: Quality, Technical, Monad Integration, Track Fit,
  Innovation — la demo/write-up tienen que pegar los cinco

| Métrica | Target | Cómo se mide |
|---|---|---|
| Release on-chain tras `job.done` | <2s | timestamp en journal vs monadscan |
| Ejecuciones con feedback on-chain | 100% | `SettleJournal` vs `NewFeedback` count |
| Failover a forge sano | <5s | demo cronometrado |
| Costo x402 percibido por cliente | 0 gas, 1 firma | flujo EIP-3009 |
| TTFT con gate de pago | +<500ms vs sin pago | medición en dashboard |
| Prompt bytes en calldata/eventos | 0 | auditoría de inputs tx |
| Datos inventados en UI | 0 | regla de oro Catalog intacta |

## 5. Riesgos y mitigaciones

| Riesgo | Prob. | Mitigación |
|---|---|---|
| Facilitator Monad v2 con API distinta a la doc | med | spike D0/D1: un settle real antes de integrar de lleno |
| agent0-sdk sin soporte Monad testnet | med | fallback: viem calls directos (ABI ~6 fns). Spike en P2-D4 |
| Re-escritura ed25519→secp256k1 rompe handshake | baja | seam `forge-net` ya es verify-fn; tests de handshake primero |
| ValidationRegistry no existe en testnet | — | attestation + L1 re-exec ya son el validation model; lo decimos |
| No llega todo | med | mínimo viable = P1+P2. Los stretch NO bloquean submission |
| Video/audio se desactualiza (spot dice "Stellar") | alta | re-render MP4 con copy Monad — el pipeline ya es determinista |

## 6. Tooling de desarrollo (para nosotros, no para el producto)

- **Monad MCP** (`monad-mcp-tau.vercel.app/sse`, comunidad): balances, txs,
  docs de Monad dentro del agente — opcional, evaluar antes de confiar.
- **agent0-sdk**: SDK TS oficial de 8004 (`registerOnChain`, `giveFeedback`,
  IPFS/data-URI registration files). Ahorra el ABI plumbing.
- Foundry para contratos, viem ≥2.40 para todo lo demás, Envio si entra el stretch.
- Sin skills de repo aplicables: esto es integración Web3 directa.
