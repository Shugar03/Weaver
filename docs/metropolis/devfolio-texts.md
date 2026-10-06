# Devfolio submission — textos listos para pegar

> Campos del formulario hackathon.monad.xyz / Devfolio. Todo en inglés (jueces EN).
> Pendiente de vos: subir el video a YouTube/Loom (está en `docs/demo/weaver-demo.mp4`)
> y pegar el link en el campo correspondiente + §6 del writeup (hoy es placeholder).

## Project name

Weaver

## Tagline (≤80 chars)

Permissionless inference on idle GPUs — measured, proven, settled on Monad.

## Description (campo principal)

Weaver is a permissionless distributed inference network. Anyone's GPU can join as
a "forge" and serve OpenAI-compatible inference; a gateway routes each request to
the cheapest warm forge using a measured Expected Time to Result — not declared
benchmarks — and settles the job in USDC on Monad.

What makes it different from a broker:

- **Measured, not declared.** Forges earn routing share by observed RTT, queue
  depth and decode velocity, weighted by their on-chain ERC-8004 reputation.
  ETR predictions are persisted and auditable (`etrErrPct` per forge).
- **Cryptographic delivery proofs.** Every remote job carries a secp256k1
  signature over `sha256(result)` bound to the exact dispatched prompt —
  including resume prefixes on failover. The escrow contract verifies it with
  `ecrecover` before releasing USDC. No signature, no payment.
- **Sub-second settlement.** `WeaverEscrow.fundJob` → `release` in the same
  session; then the gateway posts ERC-8004 `giveFeedback` linking
  `{jobId, fundTx, releaseTx, resultHash}` as permanent evidence.
- **Machine-payable by design.** Canonical x402 v2: a client signs an EIP-3009
  `transferWithAuthorization` (gasless), the facilitator settles, the escrow
  releases — two legs on-chain, zero custody.
- **Zero Data Retention.** Prompts live in volatile forge RAM and die with the
  request; nothing is persisted by the network.
- **Hardened for real adversaries.** Auth-gated tool execution, SSRF-resistant
  web_fetch, bounded inputs/heartbeats, end-to-end cancellation that actually
  frees the forge's GPU, and a wire-real E2E suite that kills daemons mid-stream
  and verifies failover, re-attestation and reputation.

### Links

- Repo: https://github.com/Shugar03/Weaver (MIT)
- Writeup: `docs/metropolis/submission-writeup.md` (in-repo)
- Demo video (≤3min): https://youtube.com/… ← subir `docs/demo/weaver-demo.mp4`
- WeaverEscrow: 0x51acE4858652D942dC7b320870e4CDbc5c989cD6 (Monad testnet 10143)
- WeaverCredits: 0xd14957AE85C4FA10fd5AB9f0d17f1cFcE2C0A498
- x402 settle + escrow release (two legs, one job):
  0x897d51fe3d1216f3cf436c604381a66349677356c73b1ed2ec4f9a7a50e0ab6e ·
  0xa884c2ac62924076d2b8abf1b2cbe7b0217eca2e37378f3e52a92cb39d852f39

### Track

Track 04 — Trust, Identity & AI Infrastructure

### Tech stack

TypeScript monorepo (pnpm/turborepo) · Hono gateway · forge daemon over
authenticated WebSockets (ed25519 + secp256k1) · Solidity/Foundry contracts ·
viem · ERC-8004 · x402 v2 + EIP-3009 · Envio HyperIndex · Mera WebAuthn SDK ·
MetaMask Delegation Framework v1.3.0 · llama.cpp / Ollama / vLLM / mflux engines.

### AI tools disclosure (si el formulario lo pide)

Built with assistance from AI coding agents (Devin/Cognition and others) across
modules, tests, contracts and docs. All protocol decisions and on-chain evidence
were verified manually. (Same text as README §Metropolis submission.)

---

## Bounty applications

### Mera Passkeys — "One Passkey, Many Keys" ($5,000)

Weaver uses Mera for zero-seed-phrase onboarding: a WebAuthn PRF extension
derives a deterministic BIP-44 Monad EOA from a single passkey via the official
`@category-labs/mera` SDK — MetaMask-compatible, mnemonic-exportable. From one
passkey we derive isolated user, agent and operator wallets (the bounty thesis:
one passkey, many keys). The gateway accepts passkey-derived EOAs natively:
`POST /v1/auth/evm/challenge` → `personal_sign` → session, then any x402/escrow
flow works without ever touching a seed phrase.

Code: `apps/web/lib/passkey.ts` · `apps/web/components/account/PasskeyAuth.tsx`
· gateway dual auth in `apps/gateway/src/index.ts` (`/v1/auth/evm/*`).

### MetaMask Delegation Toolkit — Best Agent Wallet ($2,500)

Forges and autonomous inference agents are self-custodial agent wallets on
Weaver. End-users delegate scoped micro-allowances via ERC-7710/7715: a
MetaMask-signed delegation whose caveats are enforced by the canonical
Delegation Framework v1.3.0 enforcers — `ERC20TransferAmount`, `AllowedTargets`,
`AllowedMethods`, `Timestamp`, `LimitedCalls` — over a real EIP-712 domain with
packed terms. The gateway verifies the delegation and redeems it once into
account credits (`dlg:<hash>` dedup; replay → 409).

Verified end-to-end: $5 delegation credited on Monad testnet, replay rejected,
pg-persisted (spec 012). Code: `packages/settlement` (10/10 TDD tests).

### Envio HyperIndex ($1,000)

An Envio indexer watches Monad testnet chain 10143 for `Deposited`,
`Funded`, `Released` (WeaverEscrow/WeaverCredits) and `NewFeedback` (ERC-8004
Reputation Registry). The gateway serves `/v1/network/{stats,leaderboard,
reputation}` computed from the real indexed tables — no fabricated metrics —
and the web dashboard renders jobs released, USDC settled, feedbacks and a
per-forge reputation panel. Reputation is Laplace-smoothed, revoked-aware, and
weights ETR routing (`REP_WEIGHT=0.3`).

Code: `indexer/` (6/6 TDD handler tests) · `apps/gateway/src/indexerstore.ts`.

### Alchemy

Monad RPC endpoint configurable via `MONAD_RPC_URL`; used as the secondary RPC
for `EvmDepositWatcher` and settlement reads (primary RPC failover path).

---

## Checklist antes de dar Submit

- [ ] Video subido (YouTube/Loom unlisted) + link pegado aquí y en el writeup §6
- [ ] Repo público verificado (MIT, tag `stellar-submission` pusheado)
- [ ] Writeup §6.2 refleja el hardening wave (ya actualizado)
- [ ] Bounty forms: Mera, MetaMask Delegation, Envio, Alchemy (textos arriba)
- [ ] Submit D9/D10 — editable hasta 11:59 PM ET del 13; que la versión juzgada sea la buena
