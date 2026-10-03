# Metropolis — investigación y estrategia Weaver

> Investigación del hackathon de Monad para el pivot Weaver (sep–oct 2026).
> Plan maestro: `plan.md` · Decisión: `docs/adr/0008-settlement-en-monad-evm.md`
> · Operación día a día: `roadmap.md`.

## Los hechos (verificados 2026-10-02)

- **Qué:** Metropolis, hackathon online global de Monad. $250k+ total:
  pool base **$145k** ($25k overall + $30k/track, $10k por puesto ×3) + bounties sponsor.
- **Plataforma:** `hackathon.monad.xyz` (login GitHub/Google/Discord). Registro abierto.
- **Fechas:** build window 1 Sep → **13 Oct 2026, 11:59 PM ET** (hard, sin late).
  Submission editable hasta el deadline — vale la versión grabada al cierre.
  Judging 14–27 Oct. Winners 3 Nov. **11 días desde hoy (2 Oct).**
- **Un proyecto, un track (§2.5):** prohibido multiple submissions; el proyecto
  compite en un solo track y no puede ganar premios de track múltiples.
  Los bounties sí se apilan encima.
- **Submission obligatorio (§4.1, §9):**
  - Repo GitHub **público y open source** (MIT/Apache/GPL/BSD — agregado `LICENSE` MIT)
  - README: setup instructions, atribución de código externo, **qué es pre-existente
    vs qué es nuevo del window**, y **disclosure de uso de AI coding tools**
  - Commit history cubriendo el build window
  - Demo video **≤3 min**, público (YouTube/Loom), producto funcionando real
    (no mockups) y **mostrando interacción on-chain con Monad**
  - Docs: descripción, arquitectura, stack, deploy
  - Contract addresses / tx hashes en Monad mainnet o testnet
- **Judging (§5.2):** todo a 20% ×5 — Product Quality, Technical Excellence,
  Monad Integration, Track Fit, Innovation & Impact. Bounties: requisitos del
  sponsor 40% + técnica 30% + Monad 20% + innovación 10%.
- **Warning §5.3:** nada es confidencial para jueces/mentores — no incluir
  secretos, keys ni nada que no quieras público.
- **Activación presencial:** Metropolis Lounge **Buenos Aires, 3 Oct** (mañana) —
  Luma linkeado desde la página del hackathon. Ir, es gratis y hay jueces.

## El track: 04 · Trust, Identity & AI Infrastructure ($30k)

Los cuatro tracks ($30k c/u, repartido entre 3 equipos):

| Track | Nosotros |
|---|---|
| 01 Finance & Trading | No. |
| 02 Consumer & Payments | Secundario posible (pay-per-job streaming) |
| 03 Social & Culture | No. |
| **04 Trust, Identity & AI** | **Sí. Es exactamente nuestro pitch.** |

El texto del track 04 pide literalmente:

- *"Agent identity and reputation under ERC-8004"* → Weaver ya TIENE esto como
  diseño: ForgeIdentity (keypair = identidad + payout), reputación medida
  (ETR/uptime), y validación por attestation + re-ejecución redundante (L1).
  Portearlo al registry estándar ERC-8004 nos vuelve la implementación
  de referencia del caso que ellos mismos piden.
- *"Teams comfortable with cryptography, protocol design, agent frameworks"*
- *"Provenance for generated media"* → `result_hash` + firma del forge ya es
  provenance del output: el pago declara qué pagó (sha256 del resultado).

La narrativa escribe sola: **"Agent trust scored on measured telemetry, not
self-declared capability"** — el scheduler no cree nada: attestation lo prueba,
ETR lo mide, reputation registry lo publica, escrow lo liquida.

## Bounties alcanzables (además del track)

- **Monad Foundation "Mera: One Passkey, Many Keys" / "Best Mera-Powered UX"**
  ($2.5k c/u) — mapea a nuestro Account layer: `acct_` anónimo → passkey wallet
  (WebAuthn/P256, que el track pide explícitamente) en vez de `wvr_` secret.
- **MetaMask "Best Agent Wallet Plugin"** ($2.5k) — el forge como agent wallet:
  firma heartbeats + proofs + cobra con la misma EVM account.
- **Envio "Best Use of Envio"** ($1k) — indexar eventos del escrow/registry para
  el dashboard live-proof (reemplaza polling de eventos).
- **Alchemy credits** — RPC. Gratis para todos los equipos de todos modos.
- Prioridad: track 04 + Mera (si el passkey account entra a tiempo). El resto,
  si sobra.

## Monad — stack técnico (verificado en docs oficiales)

| Dato | Valor |
|---|---|
| Testnet chain ID | `10143` (mainnet `143`) · x402 network `eip155:10143` |
| RPC | `https://testnet-rpc.monad.xyz` (50 rps) · `wss://` · viem ≥2.40 ya trae `monadTestnet` |
| Explorers | `testnet.monadvision.com` / `testnet.monadscan.com` (con verificación de contratos) |
| Faucets | `faucet.monad.xyz` (MON gas) · `faucet.circle.com` (USDC testnet, 1 USDC / 2h) |
| **USDC testnet** | `0x534b2f3A21130d7a60830c2Df862319e593943A3` — **USDC oficial de Circle**, 6 dec, soporta **EIP-3009** `transferWithAuthorization`. NO necesitamos token propio |
| Finalidad | ~sub-segundo — el verify de x402 no agrega latencia percibida al primer token |

## Tooling del ecosistema (no construir de cero)

- **Monad Foundry**: fork oficial de Foundry — `foundryup --network monad`,
  template `forge init --template monad-developers/foundry-monad`. `evmVersion: prague`, solc 0.8.28.
- **ERC-8004 ya deployado en Monad** (singletons CREATE2, mismos address en todas las cadenas):
  - testnet Identity `0x8004A818BFB912233c491871b3d84c89A494BD9e`
  - testnet Reputation `0x8004B663056A597Dffe9eCcC1965A193B7388713`
  - guía oficial: `docs.monad.xyz/guides/erc-8004` · explorers: `erc-8004.quicknode.com`, `8004scan.io`
  - **SDK oficial: `agent0-sdk`** (npm, MIT, `sdk.ag0.xyz`) — `registerOnChain()` con
    registration file en data:URI, `giveFeedback`, discovery. Fallback: viem calls directos.
  - → integración = llamar los registries canónicos, **no** deployar los nuestros.
- **x402**: facilitator oficial de Monad `https://x402-facilitator.molandak.org` (v2 only),
  SDK `@x402/evm` `ExactEvmScheme` + `HTTPFacilitatorClient`. Guía: `docs.monad.xyz/guides/x402`.
  El pagador firma EIP-3009 off-chain → **gasless para el cliente**, el facilitator liquida.
- **Mera** (`mera.category.xyz`, Category Labs): passkey → BIP-44 EOA via WebAuthn PRF.
  Sin contratos, sin backend de custodia — el Account layer pasa a "Face ID → EOA".
- **MetaMask Delegation Toolkit** (ERC-7710/7715): delegations EIP-712 con caveats
  (spending limit, contract target, time bound). Story del bounty: el usuario delega
  un presupuesto acotado al agente Weaver que paga jobs via x402.
- **Envio HyperIndex**: soporta Monad testnet (chainId `10143`) — indexar `Funded/Released`
  del escrow + `NewFeedback` del ReputationRegistry → dashboard live sin polling propio.
- **Monad MCP** (`monad-mcp-tau.vercel.app/sse`, proyecto de comunidad): balances,
  tx, `monad-docs` dentro del IDE/agente. Útil para nosotros, no va en el producto —
  evaluar antes de confiarle nada (endpoint de terceros).
- Referencia en el ecosistema: **Dispatch** ya corre coordinadores de cómputo x402 en
  Monad — valida el mercado; nuestro diferencial es la capa de trust (8004 + attestation).

## Qué cambia y qué no (resumen)

**No cambia (la tesis):** scheduler ETR, failover, telemetría medida, ZDR,
forges remotos por WS, attestation, proof L0/L1, API OpenAI-compatible.

**Cambia (la cadena):**
- `contracts/weaver-escrow`: Rust/Soroban → **Solidity** (Monad Foundry). Misma API:
  `registerForge / fundJob / release / refund / getJob` + eventos.
  + `WeaverCredits.sol` (depósitos con `accountId` en calldata — reemplaza el memo).
- ForgeIdentity: ed25519/Stellar → **secp256k1 EOA** (ecrecover). El pubkey ya
  era identidad+payout — ahora además es una wallet MetaMask-compatible.
- `packages/settlement`: `RpcSubmitter` (soroban-rpc) → `EvmSubmitter` (viem).
  El `ChainSubmitter` port ya existe — el seam hizo su trabajo.
- x402 paywall: pago USDC Stellar → **x402 v2 sobre el facilitator de Monad**
  (EIP-3009, gasless para el cliente) — SDK oficial, no verify casero.
- `DepositWatcher` (Horizon + memo) → listener de `Deposited(bytes32 account, uint256)`
  del WeaverCredits (o Envio indexer).
- **ERC-8004**: cada forge llama `registerAgent`/`setAgentURI` en el IdentityRegistry
  canónico (agentId = NFT del forge); el gateway postea `giveFeedback` en el
  ReputationRegistry por ejecución (score = f(ETR medido, éxito)).
  Validation = nuestras attestation benchmarks — el "trust model" de L1 ya existe
  (ValidationRegistry oficial está en due-diligence upstream).

## Riesgos

- **11 días.** El port es acotado por diseño (ports/adapters): 2 contratos
  propios (escrow + credits), el resto es integración con infra canónica ya
  deployada. Scope mínimo defendible en `roadmap.md`.
- ERC-8004 sigue en **Draft** upstream y ValidationRegistry aún no está en
  Monad testnet — usamos Identity+Reputation canónicos y nuestra attestation
  como capa de validación. Decirlo así en el write-up.
- Reputación on-chain por ejecución = una tx por job. Bien para demo (volumen
  bajo), documentar como `feedback` batched para producción.
- El facilitator de Monad solo soporta x402 **v2** — verificar la API del SDK
  `@x402` vigente antes de integrar (hay migration guide v1→v2).
