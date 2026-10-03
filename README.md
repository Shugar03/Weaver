# Weaver — The new datacenter has no walls.

Open inference on any GPU, settled onchain. No top-ups, no subscriptions, no middleman.

> **Metropolis (Monad hackathon, deadline 13 Oct):** Weaver se presenta al track
> **04 · Trust, Identity & AI Infrastructure** — los forges son agentes con
> identidad/reputación on-chain estilo **ERC-8004** y liquidación por job en
> un escrow EVM. Estrategia: `docs/metropolis/README.md` · Plan: `docs/metropolis/plan.md`
> · Decisión: `docs/adr/0008-settlement-en-monad-evm.md` · Día a día: `docs/metropolis/roadmap.md`.
> (La implementación previa sobre Stellar/Soroban queda como referencia — ver
> sección *Live proof* histórica abajo.)

Weaver routes each request to the cheapest HOT forge (measured ETR, not marketing),
survives dead nodes by failover, and pays per job in USDC through an onchain escrow.
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
3. **Settle on Stellar.** The client pays per request via x402; the operator's
   Soroban escrow releases USDC to the worker bound to the result's sha256 —
   the payment declares what it paid for. Per job, no expiring credits.
   (`contracts/weaver-escrow`)
4. **Keep zero data.** Prompts live in RAM and die with the request; chats persist
   only on your device (deletable). Public ledger, private prompts. (`/security`)

## Live proof (histórico — Stellar testnet, verify it yourself)

- fund $0.01: https://stellar.expert/explorer/testnet/tx/d414d8fd8e5f16ed2f971729b99a71c4b8c0843427fd1a0277605f10e851ade7
- release (con result_hash + firma ed25519 verificada): https://stellar.expert/explorer/testnet/tx/00f8971a9772a21e7348cad928c5370ebdcee126e6f5bd4f978e42c7f23d8eab
- contract v3: https://stellar.expert/explorer/testnet/contract/CDHD6QRVGY5XNX6XUUYVCGJ6PH476J4YQXOSLJXH3RIPDRPW4PXWSENB

Demo video script (3 min, ES + EN subs, failover + Stellar): [`docs/demo-guion.md`](docs/demo-guion.md).

## Quickstart (MacBook Air M5, 16 GB)

```bash
nvm use # Node 24+ (.nvmrc — type-stripping needs >=22.18)
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
- `apps/web/` Next.js 16 — landing, `/dashboard` (RUN + fleet + on-chain proof), `/network`, `/chat`, `/forge`, `/developers`, `/security`
- `packages/scheduler/` deep module: `select(job, forges) -> decision` (ETR, warm-first)
- `packages/forge-exec/` execution seam: `OllamaMLXAdapter`, `FakeForgeExec` (SIM standby), failover
- `packages/settlement/` dual seam `SETTLE_CHAIN`: Stellar/Soroban + **Monad EVM** (`EvmSubmitter`, `EvmEscrowSettlement`, ERC-8004, x402 v2)
- `packages/accounts/` credit ledger + deposit watchers (Horizon memo / `Deposited` EVM)
- `packages/telemetry/` `record(sample)` + p50/p95, capped in-memory
- `packages/api-keys/` provider keys (`wvr_`, SHA-256, operator-gated admin)
- `packages/benchmarks/` gateway-vs-direct runner + results
- `contracts/weaver-escrow-evm/` Solidity `WeaverEscrow` + `WeaverCredits` (Monad, Foundry)
- `contracts/weaver-escrow/` Soroban `init/fund_job/release/refund/get_job` — backend previo, mantenido
- `docs/` pitch evidence (`demanda-`, `competidores-evidencia`), demo script, roadmap notes
- `docs/pitch/` submission deck — `index.html` (11 slides, self-contained, abrir directo en el browser) + `weaver-pitch.pdf` (generado via `Cmd+P` sobre el HTML)
- `scripts/` `demo-capture.mjs` (3 deterministic takes), `chat-test.mjs`, `shot.mjs`

## Contracts

- HTTP: `POST /v1/chat/completions`, `POST /v1/jobs`, `GET /v1/forges`, `GET /v1/models`, `GET /v1/executions`
- **Monad testnet** (chain `10143`, activo — `SETTLE_CHAIN=evm`):
  - `WeaverEscrow` [`0x51acE4858652D942dC7b320870e4CDbc5c989cD6`](https://testnet.monadvision.com/address/0x51acE4858652D942dC7b320870e4CDbc5c989cD6) — verificado Sourcify
  - `WeaverCredits` [`0xd14957AE85C4FA10fd5AB9f0d17f1cFcE2C0A498`](https://testnet.monadvision.com/address/0xd14957AE85C4FA10fd5AB9f0d17f1cFcE2C0A498) — verificado Sourcify
  - USDC testnet `0x534b2f3A21130d7a60830c2Df862319e593943A3` · ERC-8004 Identity `0x8004A818BFB912233c491871b3d84c89A494BD9e` · Reputation `0x8004B663056A597Dffe9eCcC1965A193B7388713`
  - Trail live verificable (`contracts/weaver-escrow-evm/deployments/testnet.json`): registerForge [`0x703c12eb…`](https://testnet.monadvision.com/tx/0x703c12eb6f138cdf6be95f1137df8548f5a3cb8ac5696015a7b02e36ce924fcf) → fundJob [`0x0069b8c8…`](https://testnet.monadvision.com/tx/0x0069b8c83da9d3deff81701577600c4e062b675f6bcad3ea56815d5b702aba90) → release [`0xa5d830a9…`](https://testnet.monadvision.com/tx/0xa5d830a9a08a25afacd3c1d9a949f3f94788a8df48bae40621f2c29a28decdc0) — el release exigió `ecrecover(personal_sign(resultHash))` del signer del forge
- Soroban testnet (backend previo, `SETTLE_CHAIN=stellar`), USDC SAC `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`

## What is NOT the MVP

Own token, on-chain inference, ZK proofs, sharding, local video, K8s, heavy local Docker.
Roadmap pointers (not dependencies): `docs/referencias-roadmap.md`.

---

## Metropolis submission

**Pre-existente (tag `stellar-submission`, Argentina Builder Challenge 27/09):** scheduler ETR,
forge-exec + failover, protocolo forge-net (WS auth/nonce/heartbeats), telemetría, ZDR,
API OpenAI-compatible, web UI, escrow + settlement Soroban, x402 v1 Stellar, credit ledger.

**Nuevo del build window (diff auditable desde el tag):** port de la capa de confianza a Monad —
contratos `WeaverEscrow`/`WeaverCredits` (Solidity, 18/18 tests Foundry), `EvmSubmitter` +
`EvmEscrowSettlement` (viem), identidad de forge secp256k1 (auth `personal_sign`, proofs
ecrecover, fleet mixta Stellar/EVM), ERC-8004 canónico (forge self-registra su agente —
agentId 1990 — y el gateway emite `giveFeedback` post-release), `EvmDepositWatcher`,
x402 v2 canónico contra el facilitator de Monad, y la web dual-chain.

**AI tooling disclosure:** este proyecto fue desarrollado con asistencia de Devin (Cognition)
y otros agentes de coding — diseño de módulos, implementación, tests, contratos y docs.
Toda decisión de protocolo y la evidencia on-chain fueron verificadas manualmente.

Built for the Argentina Builder Challenge (Stellar) — submission: [deck](docs/pitch/index.html) + demo, 27/09.
Pivot a **Monad / Metropolis** (ADR-0008): [strategy](docs/metropolis/README.md) · [roadmap](docs/metropolis/roadmap.md) · [launch film 30s](docs/launch/weaver-launch.mp4).
