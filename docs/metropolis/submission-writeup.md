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

## 7. Pre-Existing vs. New (Metropolis Build Window)
- **Pre-existing (commit tag `stellar-submission`, Sept 27):** Core ETR scheduler engine, WebSocket daemon protocol (`forge-net`), telemetry collection, ZDR pipeline, and initial Stellar/Soroban proof-of-concept.
- **Built during Metropolis window:** Complete transition to Monad EVM: custom Solidity contracts (`WeaverEscrow`, `WeaverCredits`) with Foundry test suites; `EvmSubmitter` and `EvmEscrowSettlement` viem adapters; forge secp256k1 `personal_sign` and `ecrecover` verification; live ERC-8004 identity and reputation integration; `EvmDepositWatcher` with reorg protection; canonical x402 v2 payment integration; and dual-chain execution web UI.

## 8. Honest Limitations & Next Steps
1. **Per-Job Feedback Scaling:** Publishing on-chain feedback per job works reliably on Monad testnet, but production rollouts will batch feedback reports via Merkle roots to optimize RPC load.
2. **Upstream ValidationRegistry:** Slashing will integrate once the official ERC-8004 `ValidationRegistry` deploys upstream on Monad.
3. **Multi-Model Redundancy:** Extending cryptographic proof verification from L0 hash matching to L1 majority-voting attestation across heterogeneous GPU clusters.
