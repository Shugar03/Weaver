# Weaver — Metropolis Track 04 Submission Writeup

## 1. TL;DR
Weaver is a permissionless distributed inference network eliminating centralized gateway markups by routing prompts across independent GPUs via measured ETR (Expected Time to Result). Every job is verified with cryptographic delivery proofs, settled in sub-second escrow on Monad testnet, and indexed into portable agent reputation under ERC-8004.

## 2. The Problem: Centralized Gateways Are Toll Booths
Open-weight models won the capability race, yet consuming them requires passing through centralized toll booths. Market realities (primary sources in `docs/competidores-evidencia.md`):
- **Tolls on credit top-ups:** Gateways pass through provider token rates but charge extractive deposit fees (OpenRouter: 5.5%, min $0.80; 8% on Business) while locking balances into non-refundable expiring credits.
- **Zero performance SLAs:** OpenRouter Terms §5.4 disclaims guarantees on an "as-available" basis. Fireworks and Together serverless offer zero latency SLAs; published 99.9% availability covers only bare 503s, not queue saturation.
- **Rationed open compute:** Subscriptions like OpenCode Go ($10/mo for up to $60 usage) impose arbitrary caps ($15/mo per premium model) that ration open silicon.

Meanwhile, billions of edge and independent GPUs sit idle. Inference is embarrassingly parallel—it requires no inter-datacenter InfiniBand fabric. Weaver unlocks this silicon by substituting platform custody with measured on-chain trust.

## 3. What We Built: The Live Loop on Monad
Weaver operates as an end-to-end distributed network running real workloads on Monad testnet:

1. **Request & ETR Routing:** The client dispatches an OpenAI-compatible prompt (`POST /v1/chat/completions`). The scheduler computes real-time ETR based on measured network RTT, active GPU queue depth, and historical decode velocity, dispatching to the optimal warm forge.
2. **Attested Execution & Streaming:** The remote forge processes the request over secure WebSockets. Prompts live strictly in volatile GPU RAM and are discarded immediately upon stream completion (Zero Data Retention).
3. **Cryptographic Delivery Proof (L0):** Upon streaming tokens, the forge signs `personal_sign(sha256(result))` using its registered secp256k1 key *while serving* before any on-chain jobId exists.
4. **Sub-Second Escrow Settlement:** The gateway funds the job escrow (`WeaverEscrow.fundJob`) and immediately calls `WeaverEscrow.release`. The smart contract performs `ecrecover` over the signed result hash against the worker's registered signer, atomically transferring USDC.
5. **ERC-8004 Reputation Indexing:** Once escrow settles, the gateway posts `giveFeedback` to the canonical ERC-8004 Reputation Registry, linking agent ID with job ID, fund tx, release tx, and output hash as immutable proof of delivery.

## 4. Monad Integration
Monad’s throughput and sub-second finality make per-job micro-settlement viable for real-time streaming LLMs.

| Component | Monad Primitive / Address | Rationale |
|---|---|---|
| **Escrow Engine** | `WeaverEscrow` (`0x51acE4858652D942dC7b320870e4CDbc5c989cD6`) | Custom Solidity contract verified on Sourcify. Holds funds and releases on-chain via `ecrecover` validation. |
| **Credit Ledger** | `WeaverCredits` (`0xd14957AE85C4FA10fd5AB9f0d17f1cFcE2C0A498`) | Emits `Deposited(bytes32 accountId, uint256 amount)` for off-chain balance synchronization without custodial risk. |
| **Settlement Token** | Circle USDC Testnet (`0x534b2f3A21130d7a60830c2Df862319e593943A3`) | Native Circle token with EIP-3009 (`transferWithAuthorization`) support, eliminating non-standard wrappers. |
| **Agent Identity** | ERC-8004 Identity Registry (`0x8004A818BFB912233c491871b3d84c89A494BD9e`) | Standardized singleton. Forges self-register sovereign agent IDs linked directly to their operating wallet. |
| **Agent Reputation** | ERC-8004 Reputation Registry (`0x8004B663056A597Dffe9eCcC1965A193B7388713`) | Stores immutable client/gateway feedback containing cryptographic proof of verified work. |
| **Gasless Paywall** | Canonical x402 Facilitator (`https://x402-facilitator.molandak.org`) | Network `eip155:10143`. Clients authorize payments via EIP-3009 without holding MON for gas. |
| **Sub-Second Finality** | Monad consensus (10k TPS, sub-second finality) | Settlement verification does not add perceptible latency to streaming LLM output. |

## 5. ERC-8004: Trust, Identity & AI Infrastructure
We implemented Track 04's exact requirements without synthetic abstractions:
- **Self-Registered Sovereign Identity:** Every forge registers its own agent ID on the canonical Identity Registry on boot (`agentId = 1991`). The identity belongs to the forge’s EOA keypair, not to the Weaver gateway.
- **Evidence-Backed Reputation:** Self-feedback is prevented by protocol. Upon job settlement, the gateway submits on-chain feedback to the Reputation Registry tagging `jobSettled`, referencing `{jobId, fundTx, releaseTx, resultHash}`.
- **Validation Layer:** Since the ERC-8004 `ValidationRegistry` is not yet deployed on Monad testnet, Weaver provides L0 cryptographic proof (secp256k1 signatures over result hashes validated on-chain in `WeaverEscrow`) alongside automated benchmark attestation.

## 6. Deliverables & Verifiable Evidence
- **Source Repository:** [github.com/Shugar03/Weaver](https://github.com/Shugar03/Weaver) (MIT License)
- **Demo Video:** [YouTube / Loom Demo Video Placeholder](https://youtube.com) (≤3 min live E2E walkthrough)
- **Verified Contracts (Monad Testnet - Chain ID 10143):**
  - WeaverEscrow: [`0x51acE4858652D942dC7b320870e4CDbc5c989cD6`](https://testnet.monadvision.com/address/0x51acE4858652D942dC7b320870e4CDbc5c989cD6)
  - WeaverCredits: [`0xd14957AE85C4FA10fd5AB9f0d17f1cFcE2C0A498`](https://testnet.monadvision.com/address/0xd14957AE85C4FA10fd5AB9f0d17f1cFcE2C0A498)
- **Live E2E Execution Trail:**
  - Remote Forge Address: `0x784E0a01c683df116fA5bb5A91180d6Fc06BF5CB`
  - Forge Registration Tx: [`0xdfec48f9...`](https://testnet.monadvision.com/tx/0xdfec48f921b5eae3dc748341243723536b265c09c3976bfd0e07525038c4aff3)
  - Fund Job #2 Tx: [`0xd8393adb...`](https://testnet.monadvision.com/tx/0xd8393adb1656de6ad4e1b1d4ced739cde91d2d32be3e13983b8cec313ed1e932)
  - Release Job #2 Tx: [`0xf06bff16...`](https://testnet.monadvision.com/tx/0xf06bff167edabf727a8cc5bdd478bc2d39ff7cd9dec1e27fb865ef94c2564b58)
  - ERC-8004 Feedback (Agent 1991): [`0xae89a2f0...`](https://testnet.monadvision.com/tx/0xae89a2f0a15ee337dd2d1548fa8a67f1bf56f051581cfe35dbc14911df6303dd)

## 6.1 New Verified Evidence (latest wave)

- **x402 Machine-Payable Inference — both legs on-chain:** `scripts/e2e-x402.mjs` funds a fresh client EOA, hits `402` with canonical `accepts`, signs EIP-3009 `transferWithAuthorization` (gasless), retries → 200 SSE from a remote forge → facilitator settle [`0x897d51fe…`](https://testnet.monadvision.com/tx/0x897d51fe3d1216f3cf436c604381a66349677356c73b1ed2ec4f9a7a50e0ab6e) (blk 67983128) **and** escrow release [`0xa884c2ac…`](https://testnet.monadvision.com/tx/0xa884c2ac62924076d2b8abf1b2cbe7b0217eca2e37378f3e52a92cb39d852f39) (blk 67983137) — client pays $0.01 to operator, operator pays forge, two txs, zero custody.
- **Verifiable receipts, client-side:** every chat completion carries `weaver_proof {jobId, forgeId, resultHash, signature}`; the web UI runs `ecrecover` locally and links the release tx that paid *against that exact proof* (`ProofChip`, spec 009).
- **Reputation decides routing:** ERC-8004 feedback (indexed via Envio, Laplace-smoothed, revoked-aware) weights ETR selection (`REP_WEIGHT=0.3`) — live `reputationScore` per forge in `/v1/forges` (spec 013). Track 04's thesis executed: measured on-chain reputation decides who computes.
- **Failover you can see:** admin `kill_forge` terminates a remote forge's session mid-request; pre-token failures reroute transparently and the client receives `weaver_route {failed, serving}` in the stream + a FAILOVER badge (spec 011/014). Mid-stream death stays an explicit error — no silent truncation.
- **Delegation session spend, live:** MetaMask-signed ERC-7710/7715 delegation → gateway verifies EIP-712 + caveats (canonical Delegation Framework v1.3.0 enforcers) → redeems once into account credits (`dlg:<hash>` dedup, replay → 409). Verified end-to-end: $5 delegation credited, replay rejected, pg-persisted (spec 012).
- **Network dashboard over the Envio index:** `/v1/network/{stats,leaderboard,reputation}` computes from real indexed tables → live UI: jobs released, USDC settled, feedbacks, forge leaderboard with registration txs, per-forge reputation panel with on-chain attestations (spec 008/010).
- **ETR calibration, honest and live:** `predictedMs` persisted per job vs measured `ttftMs+decodeMs` → `etrErrPct` per forge in `/v1/forges` — the "measured, not declared" claim is externally auditable (spec 015).

## 6.2 Protocol hardening wave (final window)

The last stretch went adversarial: instead of adding surface features, we attacked our own stack and wired a wire-real E2E harness. All commits auditable on `main`.

- **Proof commitment era (L0 strengthened):** forge signatures now bind the *exact dispatched prompt* plus served output — `promptHash` also covers `resume.prefix`, so a resumed stream's proof commits to what the client already consumed. A forge cannot serve output for a different prompt and still get paid. Reasoning-model fix: `think` tokens are excluded from `resultHash` — the proof no longer stays permanently invalid on models that emit reasoning traces.
- **Client-initiated cancellation, both engines:** aborting the HTTP request propagates `job.cancel` over the forge channel → the daemon's `AbortController` kills the text engine or SIGKILLs the image subprocess (`mflux`). Channel death and daemon `stop()` abort every in-flight job — no zombie GPU work, no `image.result` after cancel. The image port gained `signal` end-to-end (`request → RemoteImageExec → daemon running map → engine`).
- **Adversarial gateway hardening:** `web_fetch` re-validates scheme+host on *every* redirect hop (a public URL 302-ing to `169.254.169.254`/`[::1]` was a working SSRF pivot) and the blocklist now covers IPv6 loopback, v4-mapped, ULA, link-local and `.local`/`.internal`; `tools/call` fail-closed — non-`readonly` tools (`run_command`, all `mcp__*`, unknown names) require the operator key (it was unauthenticated command execution on the operator's machine); `run_command` args are path-sandboxed to the workspace cwd (lexical resolve + `realpath`, symlink-safe); generation bounds clamped (`num_ctx`/`max_tokens`/`temperature`/`top_p`, serialized tools count toward the 60k prompt cap); heartbeat bounds (≤16 instances per heartbeat — each triggers real attestation — plus string/numeric ranges so forged telemetry can't game the scheduler); 4 MiB body cap, WS `maxPayload`, bounded `idempotency-key`, signup rate limit.
- **Wire-real E2E harness (`@weaver/e2e`):** a real gateway + `attachForgeWS` + real challenge/ed25519 auth + real attestation + scripted engines — everything over the socket except the model. Covered: mid-stream resume (failover hands `resume.prefix` to the survivor and the proof binds it), admin kill-switch mid-stream (failover + daemon-side abort + killed pubkey can't re-register + revive), image attestation with real PNG dims + post-attest garbage → `502` (never served), autonomous `connectLoop` reconnect → re-attestation → service restored, and HTTP-abort propagating to the forge engine.
- **Engine adapters & transport:** OpenAI-compatible engine adapter (vLLM / llama.cpp-server remote engines), cluster-forge verified live over llama.cpp RPC (ADR-0010 — model sharded across nodes), native TLS/wss on the forge↔gateway channel, daemon reconnect with exponential backoff + mid-stream resume (S45).
- **Bugs the harness caught:** daemon `stop()` never closed its socket (`DaemonChannel.close`), gateway `fws.stop()` left upgraded sockets hanging (~30s close handshake), heartbeat flood false-positive, telemetry bigint/float coercion silently dropping settled samples, deposit watcher crediting 10% (spec 016), proof `promptHash` missing the resume prefix.
- **Test surface at submission:** gateway 209 · forge-net 56 · forge 19 · forge-exec 55 · contracts 18/18 Foundry · wire-E2E 6 · browser army 22/22 — all green.

## 7. Pre-Existing vs. New (Metropolis Build Window)
- **Pre-existing (commit tag `stellar-submission`, Sept 27):** Core ETR scheduler engine, WebSocket daemon protocol (`forge-net`), telemetry collection, ZDR pipeline, and initial Stellar/Soroban proof-of-concept.
- **Built during Metropolis window:** Complete transition to Monad EVM: custom Solidity contracts (`WeaverEscrow`, `WeaverCredits`) with Foundry test suites; `EvmSubmitter` and `EvmEscrowSettlement` viem adapters; forge secp256k1 `personal_sign` and `ecrecover` verification; live ERC-8004 identity and reputation integration; `EvmDepositWatcher` with reorg protection; canonical x402 v2 payment integration; dual-chain execution web UI; the full §6.2 hardening wave (input-bound proofs, end-to-end cancellation, adversarial gateway hardening, kill switch) and the wire-real E2E suite.

## 8. Honest Limitations & Next Steps
1. **Per-Job Feedback Scaling:** Publishing on-chain feedback per job works reliably on Monad testnet, but production rollouts will batch feedback reports via Merkle roots to optimize RPC load.
2. **Upstream ValidationRegistry:** Slashing will integrate once the official ERC-8004 `ValidationRegistry` deploys upstream on Monad.
3. **Multi-Model Redundancy:** Extending cryptographic proof verification from L0 hash matching to L1 majority-voting attestation across heterogeneous GPU clusters.

## 9. Sponsor Bounties Integration
- **Envio HyperIndex ($1,000):** Real-time GraphQL event indexing for `Deposited`, `Funded`, `Released`, and `NewFeedback` on Monad Testnet Chain ID 10143 (package `indexer/`, 6/6 TDD tests passing).
- **MetaMask Delegation Toolkit — Best Agent Wallet ($2,500):** Forges and autonomous inference agents operate as self-custodial agent wallets. End-users delegate scoped micro-allowances via ERC-7710/ERC-7715 with caveats (canonical Delegation Framework v1.3.0 enforcers — `ERC20TransferAmount`, `AllowedTargets`, `AllowedMethods`, `Timestamp`, `LimitedCalls` — real EIP-712 domain + packed terms) in `@weaver/settlement` (10/10 TDD tests passing).
- **Monad Foundation & Category Labs — Mera Passkeys ($5,000):** Zero-seed-phrase onboarding using WebAuthn PRF extension to derive deterministic BIP-44 Monad EOAs via the official `@category-labs/mera` SDK (mnemonic-exportable, MetaMask-compatible). Implements **"One Passkey, Many Keys"** deriving isolated user, agent, and operator wallets from a single passkey (`apps/web/lib/passkey.ts`, `apps/web/components/account/PasskeyAuth.tsx`, and gateway dual auth).
- **Alchemy:** Monad RPC configuration via `MONAD_RPC_URL`.

