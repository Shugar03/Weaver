# Metropolis Sponsor Bounties Analysis

This document evaluates eligible sponsor bounties for Weaver in the Monad Metropolis Hackathon (September 1 – October 13, 2026).

---

## Strategic Overview

- **Core Priority:** **Track 04 · Trust, Identity & AI Infrastructure** ($30,000 track prize pool). All architectural decisions prioritize delivering a rock-solid, fully verifiable Track 04 submission.
- **Hackathon Rule (§2.5):** Projects may only compete in a single primary track, but sponsor bounties can be stacked on top without restriction.
- **Bounty Selection Rule:** Target bounties that either align directly with existing work ("free" leverage) or require minimal, non-invasive additions (Effort S). High-risk refactors that could jeopardize core demo reliability are deferred post-deadline.

---

## Bounty Evaluation Matrix

| Sponsor / Bounty | Prize | Relevancy & Mapping | Status | Effort | Action Plan |
|---|---|---|---|---|---|
| **MetaMask Delegation** (Agent Wallet) | $2,500 | Autonomous forge wallets signing proofs & payments + scoped ERC-7715 caveats | **Completed (✓)** | S/M | Fully implemented in `@weaver/settlement` (`DelegationEngine`, caveats, EIP-712) |
| **Monad / Mera** (Passkey UX) | $5,000 ($2.5k × 2) | Anonymous account layer with WebAuthn PRF deterministic Monad EOAs | **Completed (✓)** | M | Implemented in `apps/web` (`lib/passkey.ts`, `PasskeyAuth.tsx`) & dual gateway auth |
| **Envio** (HyperIndex) | $1,000 | Event indexing for `Deposited`, `Released`, `NewFeedback` | **Completed (✓)** | S | Standalone indexer in `indexer/`, 6/6 tests passing |
| **Alchemy** (Developer Credits) | Credits | Standard RPC endpoint configuration | **Completed (✓)** | S (Trivial) | Configured via `MONAD_RPC_URL` / `EVM_RPC_URL` |

---

## Detailed Bounty Breakdown

### 1. MetaMask Delegation Toolkit — Best Agent Wallet / Plugin ($2,500)

- **What it asks:** Creative application of the MetaMask Delegation Toolkit (ERC-7710 / ERC-7715) enabling autonomous agent wallets, session-key capabilities, or scoped delegation caveats.
- **How Weaver maps:**
  - In Weaver, **the forge is an autonomous agent wallet**. Every worker runs an independent EOA identity that signs network heartbeats, attests model availability, computes cryptographic delivery proofs (`personal_sign` on output hashes), and claims earnings on-chain.
  - The Weaver gateway also operates as an automated agent managing escrow releases and reputation feedback.
- **What was implemented:**
  - Full ERC-7710 / ERC-7715 delegation engine (`packages/settlement/src/delegation.ts`):
    - Canonical Delegation Framework v1.3.0 enforcers on Monad testnet: `ERC20TransferAmountEnforcer` (USDC budget), `AllowedTargetsEnforcer`, `AllowedMethodsEnforcer`, `TimestampEnforcer`, `LimitedCallsEnforcer`.
    - Correct `encodePacked` caveat terms matching on-chain Solidity decoding.
    - Real EIP-712 domain (`DelegationManager`, v1, verifyingContract `0xdb9B1e94…`) — signatures verify against the actual deployment.
    - `DelegationEngine`: off-chain enforcer mirror — parses `transfer` calldata for spending, enforces targets/methods/time/call-count before on-chain submission.
    - 10/10 unit tests passing in `packages/settlement/tests/delegation.test.ts`.
- **Verdict:** **COMPLETED (✓).** Submit for the $2,500 Best Agent Wallet bounty.

---

### 2. Monad Foundation & Category Labs — Mera Passkey Bounties ($5,000 Total)
*Bounties: "Mera: One Passkey, Many Keys" ($2,500) and "Best Mera-Powered UX" ($2,500)*

- **What it asks:** Seamless user onboarding using Mera passkeys (WebAuthn PRF generating deterministic BIP-44 EOAs on Monad without seed phrases, centralized custody, or smart account overhead).
- **How Weaver maps:**
  - Weaver's `packages/accounts` provides an anonymous, self-custodial account model (`acct_` tokens linked to EVM wallet addresses).
  - The web interface (`apps/web`) is deliberately designed around zero-friction onboarding: users can test models immediately.
- **What was implemented:**
  - WebAuthn PRF deterministic EOA derivation (`apps/web/lib/passkey.ts`):
    - Official `@category-labs/mera` SDK (`createPasskeyWithPrfOutput` / `getPasskeyPrfOutput`) with canonical BIP-44 derivation (`m/44'/60'/0'/0/index`) — the mnemonic exports and imports identically into MetaMask/Rabby.
    - Implements **"One Passkey, Many Keys"**: single passkey seed derives separate isolated roles:
      - Role 0 (`user`): Main wallet for balance and deposits.
      - Role 1 (`agent`): Autonomous inference runner wallet.
      - Role 2 (`operator`): Staking and forge management wallet.
    - Interactive UI component `apps/web/components/account/PasskeyAuth.tsx` integrated into `LoginPanel.tsx`.
    - Gateway `dualVerify` integration: supports challenge-response signing for both EVM addresses (`0x...`) and Stellar (`G...`).
    - 4/4 tests passing in `apps/web/tests/passkey.test.ts` + EVM login test in `apps/gateway/tests/accounts.test.ts`.
- **Verdict:** **COMPLETED (✓).** Submit for both Mera bounties ($5,000 total).

---

### 3. Envio — Best Use of Envio ($1,000)

- **What it asks:** Using Envio HyperIndex to index on-chain events on Monad testnet (Chain ID 10143) into a real-time GraphQL API.
- **How Weaver maps today:**
  - Weaver produces clean on-chain events across its contract suite:
    - `WeaverCredits`: `Deposited(bytes32 indexed account, address indexed sender, uint256 amount)`
    - `WeaverEscrow`: `Funded(uint256 indexed jobId, ...)`, `Released(uint256 indexed jobId, bytes32 resultHash)`, `Refunded(uint256 indexed jobId)`, `ForgeRegistered(...)`
    - ERC-8004: `NewFeedback(uint256 indexed agentId, string tag, ...)`
  - Self-contained indexer package in `indexer/` targeting Monad Testnet (`10143`).
- **What is delivered:**
  - Standalone Envio HyperIndex package (`indexer/`) with `config.yaml`, `schema.graphql`, `abis/`, `src/EventHandlers.ts`, and `tests/handlers.test.ts`.
  - In-memory TDD test suite (6/6 passing) verifying pure event transformations and aggregate metrics.
  - GraphQL schema exposing `Job`, `Deposit`, `Forge` (with earnings aggregates), `Agent`, `Feedback`, and `ProtocolMetric` entities with sample queries in `indexer/README.md`.
- **Effort:** **Small (S)**.
- **Verdict:** **COMPLETED (✓).** Ready for hosted service deployment (`envio deploy`) and submission for the $1,000 bounty.

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
