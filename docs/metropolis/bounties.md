# Metropolis Sponsor Bounties Analysis

This document evaluates eligible sponsor bounties for Weaver in the Monad Metropolis Hackathon (September 1 – October 13, 2026).

---

## Strategic Overview

- **Core Priority:** **Track 04 · Trust, Identity & AI Infrastructure** ($30,000 track prize pool). All architectural decisions prioritize delivering a rock-solid, fully verifiable Track 04 submission.
- **Hackathon Rule (§2.5):** Projects may only compete in a single primary track, but sponsor bounties can be stacked on top without restriction.
- **Bounty Selection Rule:** Target bounties that either align directly with existing work ("free" leverage) or require minimal, non-invasive additions (Effort S). High-risk refactors that could jeopardize core demo reliability are deferred post-deadline.

---

## Bounty Evaluation Matrix

| Sponsor / Bounty | Prize | Relevancy & Mapping | Missing Scope | Effort | Action Plan |
|---|---|---|---|---|---|
| **MetaMask Delegation** (Agent Wallet) | $2,500 | Autonomous forge wallets signing proofs & payments | Scoped user allowance delegation caveats | S/M | **Apply** (highlight agent architecture in writeup) |
| **Monad / Mera** (Passkey UX) | $5,000 ($2.5k × 2) | Anonymous `acct_` layer ready for EOA passkeys | Mera WebAuthn SDK frontend integration | M | **Evaluate** (build if UI polish allows) |
| **Envio** (HyperIndex) | $1,000 | Event indexing for `Deposited`, `Released`, `NewFeedback` | `config.yaml` schema + GraphQL consumer | S | **Apply** if low-friction indexing template ready |
| **Alchemy** (Developer Credits) | Credits | Standard RPC endpoint configuration | Set `MONAD_RPC_URL` to Alchemy endpoint | S (Trivial) | **Claim** immediately |

---

## Detailed Bounty Breakdown

### 1. MetaMask Delegation Toolkit — Best Agent Wallet / Plugin ($2,500)

- **What it asks:** Creative application of the MetaMask Delegation Toolkit (ERC-7710 / ERC-7715) enabling autonomous agent wallets, session-key capabilities, or scoped delegation caveats.
- **How Weaver maps today:**
  - In Weaver, **the forge is an autonomous agent wallet**. Every worker runs an independent EOA identity that signs network heartbeats, attests model availability, computes cryptographic delivery proofs (`personal_sign` on output hashes), and claims earnings on-chain.
  - The Weaver gateway also operates as an automated agent managing escrow releases and reputation feedback.
- **What is missing for the bounty:**
  - Allowing the end-user to delegate a bounded micro-spending allowance (e.g., maximum $5.00 USDC for 24 hours, restricted to `WeaverEscrow` or x402 calls) using ERC-7715 caveats, so their agent can run batch prompts without requiring interactive wallet confirmations per request.
- **Effort:** **Small/Medium (S/M)**. The conceptual architecture is 100% natural; implementing the caveat contract or client wrapper takes ~1 day.
- **Verdict:** **High priority bounty.** Present Weaver’s forge architecture as a premier example of autonomous agent wallets serving real computational workloads.

---

### 2. Monad Foundation & Category Labs — Mera Passkey Bounties ($5,000 Total)
*Bounties: "Mera: One Passkey, Many Keys" ($2,500) and "Best Mera-Powered UX" ($2,500)*

- **What it asks:** Seamless user onboarding using Mera passkeys (WebAuthn PRF generating deterministic BIP-44 EOAs on Monad without seed phrases, centralized custody, or smart account overhead).
- **How Weaver maps today:**
  - Weaver's `packages/accounts` already provides an anonymous, self-custodial account model (`acct_` tokens linked to EVM wallet addresses).
  - The web interface (`apps/web`) is deliberately designed around zero-friction onboarding: users can test models immediately.
- **What is missing for the bounty:**
  - Integrating Mera’s SDK (`@mera/core` or browser provider) in `apps/web` to replace the raw session token with a "Sign in with Touch ID / Face ID" button that derives the user’s Monad EOA on the fly.
- **Effort:** **Medium (M)**. Straightforward UI integration, but requires careful testing to ensure no regressions in the demo flow.
- **Verdict:** **Secondary priority.** Implement if core video and testing are locked in ahead of schedule. Even without full SDK wiring, the UX design pattern directly reflects the Mera thesis.

---

### 3. Envio — Best Use of Envio ($1,000)

- **What it asks:** Using Envio HyperIndex to index on-chain events on Monad testnet (Chain ID 10143) into a real-time GraphQL API.
- **How Weaver maps today:**
  - Weaver produces clean on-chain events across its contract suite:
    - `WeaverCredits`: `Deposited(bytes32 indexed account, address indexed sender, uint256 amount)`
    - `WeaverEscrow`: `Funded(uint256 indexed jobId, ...)`, `Released(uint256 indexed jobId, bytes32 resultHash)`, `Refunded(uint256 indexed jobId)`
    - ERC-8004: `NewFeedback(uint256 indexed agentId, string tag, ...)`
  - Currently, `EvmDepositWatcher` ingests these via paginated `eth_getLogs`.
- **What is missing for the bounty:**
  - An Envio indexer directory (`config.yaml`, `schema.graphql`, `src/EventHandlers.ts`) listening to the `WeaverCredits` and `WeaverEscrow` contracts on testnet, providing a GraphQL query endpoint for the web dashboard.
- **Effort:** **Small (S)** (~4 hours of configuration).
- **Verdict:** **Quick win if time permits.** If not fully wired to the UI before the deadline, our existing `eth_getLogs` watcher with reorg deduplication already functions reliably in production.

---

### 4. Alchemy — Developer & Node Credits

- **What it asks:** Integration with Alchemy infrastructure and RPC services on Monad.
- **How Weaver maps today:**
  - Weaver's `EvmSubmitter` and deposit watcher take standard EVM RPC endpoints via environment variable `MONAD_RPC_URL`.
- **What is missing:**
  - Pointing configurations to Alchemy's Monad endpoint when provisioned.
- **Effort:** **Trivial (S)**.
- **Verdict:** **Automatic claim.** Claim credits to support high-throughput load testing during demo recordings.

---

## Conclusion & Action Recommendation

1. **Commit 90% of energy to Track 04 judging criteria:** Product quality, measured trust thesis, verifiable on-chain proofs, and live demo execution.
2. **Apply for MetaMask Delegation:** Structure the writeup to emphasize the forge as an autonomous agent wallet performing cryptographic tasks and receiving direct micro-settlement.
3. **Keep Envio and Mera as modular extensions:** Integrate them strictly through non-breaking frontend/indexer components after the core video and submission package are locked.
