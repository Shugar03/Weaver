# Weaver

GPUs heterogéneas como nube IA programable, con settlement en Stellar (x402 + Soroban).

Monolito modular con bordes hexagonales livianos. Un deploy, Modules con Interfaces chicas, Adapters intercambiables.

## Quickstart (Air M5 16GB)

```bash
nvm use # Node 20.9+
corepack enable && pnpm install
ollama serve # en otra terminal, backend MLX
ollama pull qwen3.5:4b
pnpm --filter @weaver/scheduler test # S1: elige HOT
pnpm dev # gateway + web cuando estén
```

## Estructura

- `apps/gateway/` Hono — `POST /v1/chat/completions` SSE, x402, scheduler
- `apps/web/` Next.js 16 — dashboard Forges HOT/COLD, bench
- `packages/scheduler/` Module profundo: `select(job, forges) -> decision`
- `packages/forge-exec/` Seam ejecución: `OllamaMLXAdapter`, `OpenRouterAdapter`
- `packages/settlement/` Seam Stellar testnet
- `packages/telemetry/` `record(sample)` + p50/p95
- `contracts/weaver-escrow/` Soroban `init/fund_job/release/refund/get_job`
- `docs/adr/` decisiones que duelen revertir

## Contratos

- HTTP: `POST /v1/chat/completions`, `GET /v1/forges`, `POST /v1/jobs`
- Soroban testnet, USDC SAC `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`

## Demo (Checkpoint 1 — video 3 min)

Historia: failover + Stellar. Guion palabra por palabra (ES + subs EN): `docs/demo-guion.md`.

```bash
OLLAMA_KEEP_ALIVE=30m ollama serve # terminal 1, modelo qwen3:4b
node apps/gateway/src/serve.ts     # terminal 2 (:3001, copiar la operator key del log)
pnpm --filter @weaver/web dev      # terminal 3 (:3000)
# 1 RUN de calentamiento en /dashboard, después:
OPERATOR_KEY=wvr_... node scripts/demo-capture.mjs # 3 tomas en /tmp/weaver-take*.png
```

Plata real (testnet, verificable):

- fund $0.01: `https://stellar.expert/explorer/testnet/tx/177a7185e3349c0adef305ec856ba6d17d6868171c66388c8d3382b5eb727655`
- release: `https://stellar.expert/explorer/testnet/tx/d6e75fcdb967b56a4dd6cd2218f1e6a12efc636287212ed48bbf1d6b2ff86b3b`
- contrato: `https://stellar.expert/explorer/testnet/contract/CDPOGSQLTLRZPCE2NF4WFVSMGQEGLOAPBM5LFCK2U26LP6B5YVN5GBU3`

## Qué NO es MVP

Token propio, inferencia on-chain, ZK, sharding, video local, K8s, Docker local pesado.
