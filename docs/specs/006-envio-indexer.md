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
