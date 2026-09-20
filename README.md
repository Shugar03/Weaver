# Weaver — The new datacenter has no walls.

Open inference on any GPU, settled on Stellar. No top-ups, no subscriptions, no middleman.

Weaver routes each request to the cheapest HOT forge (measured ETR, not marketing),
survives dead nodes by failover, and pays per job in USDC through a Soroban escrow.
Prompts live in RAM and die with the request — the chain only ever sees money.

## The problem: open models won, but using them means paying a toll

Demand is exploding (Google went from ~10T to 3.2Q tokens/month in two years —
Pichai, I/O 2026) while three clouds hold ~63% of infra (Synergy, Q2-2025).
To serve open models you go through centralized gateways that:

- charge you to top up credits (OpenRouter: 5.5%, min $0.80; 8% on Business),
- guarantee nothing (OpenRouter Terms §5.4: availability on an "as-available" basis;
  Fireworks and Together ship serverless with no latency/availability SLA),
- ration open models through subscriptions (OpenCode Go: $10/mo for up to $60 of
  usage, $15 caps per premium model).

Full evidence, all primary sources: [`docs/competidores-evidencia.md`](docs/competidores-evidencia.md).
Demand data: [`docs/demanda-evidencia.md`](docs/demanda-evidencia.md).

## The insight: the silicon is already out there

Back-of-the-envelope, derived from public data (not a single primary source —
read it as an order of magnitude, not a census):

- **Installed base:** ~1.5B active PCs plus ~4.5B smartphones/consoles
  (Gartner/IDC/Canalys/Statista), versus ~30–45M physical servers worldwide
  (Uptime Institute/Synergy). 30–50 edge devices per datacenter server.
- **Raw FLOPS:** an RTX 4090 pushes 80+ TFLOPS (FP32); even mid-range cards and
  Apple/Qualcomm SoCs deliver several TFLOPS. Multiplied by the installed base,
  aggregate edge FLOPS plausibly hold ~70–85% of the planet's silicon —
  almost entirely idle (typical personal use: browser or sleep).
- **Empirical proof it aggregates:** Folding@home passed **2.4 ExaFLOPS** in 2020,
  beating the TOP500 supercomputers combined — on volunteers' idle machines.

The honest caveat (Amdahl + physics): datacenters win at *coordinated* compute —
InfiniBand/RDMA at 400–800 Gbps and microsecond latency versus residential
milliseconds. Training a giant model over home internet is hopeless.

But **inference is embarrassingly parallel**: each request is independent, no
cross-node chatter needed. That is exactly the workload idle edge silicon can
serve — and exactly what Weaver routes and settles.

## How it works

1. **Route by measured ETR.** The scheduler scores every forge on expected time
   to result (RTT + queue + load-if-COLD + prefill + gen + verify) and picks the
   cheapest HOT one. No server picking, no config. (`packages/scheduler`)
2. **Survive dead nodes.** Kill the primary and the next request fails over to
   standby, live — nodes fall, the network doesn't. (`/dashboard` → Kill Forge)
3. **Settle on Stellar.** Soroban escrow in USDC: the client funds, the contract
   releases to the worker on result. Per job, no expiring credits.
   (`contracts/weaver-escrow`)
4. **Keep zero data.** Prompts live in RAM and die with the request; chats persist
   only on your device (deletable). Public ledger, private prompts. (`/security`)

## Live proof (Stellar testnet, verify it yourself)

- fund $0.01: https://stellar.expert/explorer/testnet/tx/177a7185e3349c0adef305ec856ba6d17d6868171c66388c8d3382b5eb727655
- release: https://stellar.expert/explorer/testnet/tx/d6e75fcdb967b56a4dd6cd2218f1e6a12efc636287212ed48bbf1d6b2ff86b3b
- contract: https://stellar.expert/explorer/testnet/contract/CDPOGSQLTLRZPCE2NF4WFVSMGQEGLOAPBM5LFCK2U26LP6B5YVN5GBU3

Demo video script (3 min, ES + EN subs, failover + Stellar): [`docs/demo-guion.md`](docs/demo-guion.md).

## Quickstart (MacBook Air M5, 16 GB)

```bash
nvm use # Node 20.9+
corepack enable && pnpm install
ollama serve # other terminal, MLX backend
ollama pull qwen3:4b
node apps/gateway/src/serve.ts # :3001 — copy the operator key from the log
pnpm --filter @weaver/web dev  # :3000 — open /dashboard, 1 warm-up RUN, then go
```

For agents (opencode/cursor/pi/hermes): `GET /v1/models`, `POST /v1/chat/completions`
(OpenAI-compatible SSE), provider keys `wvr_` — see `/developers` in the web app.

## Structure

Monolito modular con bordes hexagonales livianos: one deploy, small-interface
Modules, swappable Adapters. (Decisions that hurt to revert: `docs/adr/`.)

- `apps/gateway/` Hono — `POST /v1/chat/completions` SSE, x402 paywall, keyauth, scheduler
- `apps/web/` Next.js 16 — landing, `/dashboard` (RUN + fleet + Stellar proof), `/chat`, `/forge`, `/developers`, `/security`
- `packages/scheduler/` deep module: `select(job, forges) -> decision` (ETR, warm-first)
- `packages/forge-exec/` execution seam: `OllamaMLXAdapter`, `FakeForgeExec` (SIM standby), failover
- `packages/settlement/` Stellar seam (testnet)
- `packages/telemetry/` `record(sample)` + p50/p95, capped in-memory
- `packages/api-keys/` provider keys (`wvr_`, SHA-256, operator-gated admin)
- `packages/benchmarks/` gateway-vs-direct runner + results
- `contracts/weaver-escrow/` Soroban `init/fund_job/release/refund/get_job` (+ `deployments/testnet.json`)
- `docs/` pitch evidence (`demanda-`, `competidores-evidencia`), demo script, roadmap notes
- `scripts/` `demo-capture.mjs` (3 deterministic takes), `chat-test.mjs`, `shot.mjs`

## Contracts

- HTTP: `POST /v1/chat/completions`, `POST /v1/jobs`, `GET /v1/forges`, `GET /v1/models`, `GET /v1/executions`
- Soroban testnet, USDC SAC `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`

## What is NOT the MVP

Own token, on-chain inference, ZK proofs, sharding, local video, K8s, heavy local Docker.
Roadmap pointers (not dependencies): `docs/referencias-roadmap.md`.

---

Built for the Argentina Builder Challenge (Stellar) — submission: deck + demo, 27/09.
