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

## Qué NO es MVP

Token propio, inferencia on-chain, ZK, sharding, video local, K8s, Docker local pesado.
