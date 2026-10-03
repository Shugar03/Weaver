# Spec 003 — Fleet mixta live: settle por formato de worker

## Estado actual

`SETTLE_CHAIN=evm|stellar` es global. El verify ya es dual por formato
(`0x…`→ecrecover, `G…`→ed25519 — `dualVerify`). Pero con chain=evm un worker
`G…` llega a `settleJob` y revienta (cast a Address). Coexisten en exec, no
en settle.

## Goal

`SettleDispatcher`: `settleJob(proof)` elige la vía por `proof.worker` —
`0x` → `EvmEscrowSettlement`, `G` → `StellarEscrowSettlement`. Ambas
configuradas → fleet dual settlea completo. Una sola → la otra clase de
worker falla settle con razón clara `no-settler-for-format` (fail honesto,
el job se sirvió pero no se pagó — visible en ledger).

## Diseño

1. `packages/settlement/src/dispatch.ts`: `class SettleDispatcher implements
   Settlement` — ctor `{evm?, stellar?}`; dispatch por `isEvmAddr(worker)`.
   Sweep/reconcile delegados a cada sub-settlement.
2. `serve.ts`: `SETTLE_CHAIN=dual` (nuevo) exige `SETTLEMENT_SECRET` +
   `STELLAR_SECRET` — arma ambos y los envuelve. `evm|stellar` legacy se
   mantiene igual (dispatcher con una sola vía).
3. Live: gateway dual + forge EVM (ya existe) + forge Stellar
   (friendbot testnet fondea la key gratis; escrow Soroban ya deployado
   del port original — reutilizar deployment).
4. E2E: `e2e-live.mjs --mode dual` o script aparte: job a cada forge →
   dos releases en dos chains, cada uno en su explorer.

## TDD

- `dispatch.test.ts`: worker `0x` → via evm recibe el call; `G` → via
  stellar; vía no configurada → error `no-settler-for-format`; journal
  compartido no se contamina entre vías (jobKey namespaces por formato).
- Live: ambos releases on-chain, cada uno verificable en su explorer.

## Riesgo honesto

El escrow Soroban necesita un deploy vivo + USDC Stellar testnet. Si el
deploy viejo murió o el friendbot no responde, se entrega el dispatcher +
test dual mock y se documenta la limitación (no se simula un "live" falso).
