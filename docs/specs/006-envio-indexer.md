# Spec 006 — Envio indexer: escrow + reputation (bounty)

## Por qué

Bounty Envio + valor real para jueces: un dashboard live de actividad del
escrow (Funded/Released/Refunded) y reputation ERC-8004 (Registered/
NewFeedback) sin correr scripts — GraphQL queryable.

## Estado actual

No hay docker → `envio dev` local (Hasura+pg) no corre. Envio tiene
**hosted service** — el deliverable real es el indexer deployable, no un
servidor local. Verificación alcanzable: `envio codegen` compila config +
handlers sin errores (typecheck del indexer), y la config queda lista para
`envio deploy` o el hosted dashboard.

## Diseño

`indexer/` en el monorepo:

- `config.yaml`: chain 10143, contratos:
  - `WeaverEscrow` @ `0x51acE4858652D942dC7b320870e4CDbc5c989cD6` — eventos
    Funded/Released/Refunded (ABI desde `contracts/weaver-escrow-evm/out/…`)
  - `WeaverCredits` @ (deploy addr en deployments/testnet.json) — Deposited
  - ERC-8004 Identity singleton — Registered; Reputation singleton —
    NewFeedback (addresses en `deployments/testnet.json` / `erc8004.ts`)
- `schema.graphql`: `Job`, `Deposit`, `Agent`, `Feedback` — cada uno con
  su txHash/block/índices por worker.
- `src/EventHandlers.ts`: handlers por evento → entities. Datos on-chain
  puros, cero métricas inventadas.
- `package.json` con `envio` pinned (versión ≥7 días publicada).
- README corto: `pnpm envio codegen` → `pnpm envio dev`/`deploy`.

## Verificación (sin docker)

- `envio codegen` verde = config válida + handlers typecheck.
- `npx envio validate` si existe.
- Deploy real al hosted Envio = paso del operador (cuenta Envio) — se
  documenta, no se finge.

## Non-goals

- Frontend del dashboard — GraphQL queryable es la interfaz; la web Weaver
  puede linkear queries de ejemplo pero no se acopla.
- Re-index de Stellar — el indexer es solo Monad (donde viven los eventos).

## Status — VERIFIED con sync real (2025-10-03)

`indexer/` en el monorepo — envio **3.12.1** pinned (≥7d). Mejor que el
plan original: no solo codegen — **sync real contra testnet en Postgres
local** (sin docker: `ENVIO_PG_*` + `envio local db-migrate` + `envio start`,
RPC-only con `for: sync` — sin token HyperSync).

**Evidencia on-chain decodificada** (tabla `Job`, `Forge` en weaver_indexer):

- Job 1: `state=released`, `amount=10000` (0.01 USDC),
  `fundTx=0x0069b8c8…` — matchea `fund_job_1` de
  `contracts/weaver-escrow-evm/deployments/testnet.json` byte-exacto.
- Forge: `0xbaD8908C…` → signer `0x7c41eb42…` (= `proof_signer` registrado).
- `codegen` + `tsc` verdes. Sync sigue en background (rate-limit público).

**Quirks documentados**: el RPC de Monad limita `eth_getLogs` a 100 bloques
(el splitter de envio converge solo); ERC-8004 `NewFeedback` usa ABI
canónico v1.1.1 verificado contra el topic real `0x6a4a6174…` (11 params —
la variante de un solo tag NO es la deployada).

**Queda para hosted**: `envio deploy` con cuenta Envio (GraphQL Hasura
público) — paso del operador, documentado en `indexer/README.md`.
