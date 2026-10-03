# @weaver/indexer — Envio HyperIndex (Monad testnet)

Indexa la actividad on-chain del protocolo en GraphQL/SQL — spec 006.

## Contratos indexados (chain 10143, desde block 67_890_000)

| Contrato | Address | Eventos |
|---|---|---|
| WeaverEscrow | `0x51acE4858652D942dC7b320870e4CDbc5c989cD6` | `ForgeRegistered`, `Funded`, `Released`, `Refunded` |
| WeaverCredits | `0xd14957AE85C4FA10fd5AB9f0d17f1cFcE2C0A498` | `Deposited` |
| ERC-8004 Identity | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | `Registered`, `URIUpdated` |
| ERC-8004 Reputation | `0x8004B663056A597Dffe9eCcC1965A193B7388713` | `NewFeedback`, `FeedbackRevoked` |

Las firmas de eventos ERC-8004 están verificadas contra logs reales
(`NewFeedback` topic `0x6a4a6174…` — ABI canónico v1.1.1, 11 params con
`tag1`+`tag2`).

## Entities

`Forge` (worker→signer), `Job` (Funded→Released/Refunded en la misma fila,
state machine on-chain), `Deposit` (topups USDC), `Agent` (identidad
ERC-8004), `Feedback` (reputación con tag/value/endpoint del escrow).

## Correr

```bash
cd indexer
pnpm install
pnpm codegen                 # genera .envio/types.d.ts (config + schema válidos)

# local sin docker: Postgres externo via ENVIO_PG_* (Hasura/GraphQL queda
# fuera — los datos aterrizan en tablas consultables por SQL)
createdb weaver_indexer
ENVIO_PG_HOST=localhost ENVIO_PG_PORT=5432 ENVIO_PG_USER=<u> \
ENVIO_PG_PASSWORD=<p> ENVIO_PG_DATABASE=weaver_indexer \
  npx envio local db-migrate up
ENVIO_PG_HOST=localhost ENVIO_PG_PORT=5432 ENVIO_PG_USER=<u> \
ENVIO_PG_PASSWORD=<p> ENVIO_PG_DATABASE=weaver_indexer \
  npx envio start

# hosted (envio.dev): pnpm deploy — requiere cuenta Envio + ENVIO_API_TOKEN
```

Notas de Monad RPC:

- `for: sync` en `config.yaml` fuerza RPC-only (sin token HyperSync). Si hay
  `ENVIO_API_TOKEN`, HyperSync acelera el backfill automáticamente.
- El RPC público limita `eth_getLogs` a ventanas de 100 bloques — el
  indexer adapta el rango solo (se ve en logs "smaller block range").
- El rate-limit (50 rps QuickNode) hace el sync lento pero fiable — backoff
  automático, sin pérdida de bloques (checkpoints en `envio_checkpoints`).

## Verificación

`pnpm codegen` + `tsc --noEmit` = config, schema y handlers válidos.
Sync real contra testnet probado: Job 1 `state=released`
`fundTx=0x0069b8c8…` (matchea `fund_job_1` del deployment record).
