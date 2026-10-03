# ADR 0008 — Settlement en Monad/EVM + identidad de forges vía ERC-8004

Fecha: 2026-10-02 · Estado: aceptado

## Contexto

Weaver se presentó al Argentina Builder Challenge (Stellar) con escrow en
Soroban. El nuevo objetivo es **Metropolis** (hackathon Monad, deadline
13 Oct) — investigación en `docs/metropolis/README.md`. El track que casa
con la tesis es 04 (Trust, Identity & AI Infrastructure), que pide
explícitamente agent identity/reputation con **ERC-8004**.

La arquitectura ya estaba preparada para esto: `packages/settlement` expone
un port `ChainSubmitter` y todo lo Stellar-específico vive detrás de él
(`RpcSubmitter`, `stellar*` helpers). El port es cambiar el adapter, no el
modelo.

## Decisión

1. **Cadena de liquidación: Monad testnet (chainId 10143).** El escrow se
   reimplementa en Solidity (`contracts/weaver-escrow-evm/` — Monad Foundry,
   `evmVersion: prague`) con la misma semántica: `init(admin, token)`,
   `registerForge(worker)`, `fundJob(amount, worker) → jobId`,
   `release(jobId, resultHash, forgeSig)`, `refund`, `getJob`, eventos
   `Funded/Released/Refunded`. Token: **USDC testnet oficial de Circle**
   `0x534b2f3A21130d7a60830c2Df862319e593943A3` (6 dec, EIP-3009) — no token propio.
2. **Identidad del forge: ed25519/Stellar → secp256k1 EOA.** La dirección
   `0x…` sigue siendo identidad + payout (invariante ADR-0007 intacto, ahora
   además MetaMask-compatible). Proof L0 pasa a ser `ecrecover` sobre
   `keccak256(resultHash ‖ jobId)` — firma estándar `personal_sign`, sin
   precompile ed25519.
3. **ERC-8004 canónico, no propio.** Ya están deployados los singletons en
   Monad testnet — los usamos, no los reimplementamos:
   - IdentityRegistry `0x8004A818BFB912233c491871b3d84c89A494BD9e` — cada forge
     minta su `agentId` (ERC-721) y `setAgentURI` apunta a su registration
     file (data:URI: endpoints, capabilities, address).
   - ReputationRegistry `0x8004B663056A597Dffe9eCcC1965A193B7388713` — el
     gateway postea `giveFeedback(agentId, value, tag1, tag2, feedbackURI)`
     por ejecución; `value` deriva de ETR medido + éxito. Reputación
     **medida**, no declarada: es el punto del producto.
4. **Pagos: x402 v2 vía facilitator oficial de Monad**
   `https://x402-facilitator.molandak.org`, SDK `@x402/evm` `ExactEvmScheme` +
   `HTTPFacilitatorClient`. El cliente firma EIP-3009 off-chain (gasless);
   el facilitator liquida el `transferWithAuthorization`. `DepositWatcher`
   pasa de Horizon+memo a listener del evento `Deposited(bytes32 account,
   uint256 amount)` del contrato `WeaverCredits` (EVM no tiene memo → calldata).
5. **Stellar queda como implementación previa** (tags/releases del repo, links
   en README histórico). No se borra: el seam queda probado con dos chains.

## Invariantes que NO se tocan

- I1–I5 de ADR-0006 (proof=trabajo servido, un pago por resultado, nada
  huérfano, self-claim, pago ∝ trabajo) — mismas garantías, otro backend.
- La única métrica de routing sigue siendo ETR medido. ERC-8004 *publica*
  la reputación; no la usa para rutear (aún — roadmap).

## Consecuencias

- Toolchain: Foundry (`forge`/`cast`/`anvil`) para el contrato; viem para
  `EvmSubmitter` y watchers; el gateway no cambia de runtime.
- `stellar*` helpers de `packages/settlement` quedan detrás de una
  bifurcación de adapter (`Submitter` por env var `SETTLE_CHAIN=evm|stellar`).
  Tests con `anvil` en vez de fake soroban.
- El payout de cada forge necesita `registerForge` onchain antes de cobrar —
  mismo flujo que hoy.
- El nombre `forge` choca con el binario de Foundry. Se tolera en docs de
  contrato ("forge tool" vs "Forge de Weaver"); en código se importa con
  alias donde haga falta.
