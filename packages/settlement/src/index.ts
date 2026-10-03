// Module Settlement — única superficie pública.
export { JOB_PRICE_USDC } from "./ports.ts";
export { EscrowSettlement, RpcSubmitter, stellarSigner, stellarVerify, stellarPubkey, stellarKeypair, payoutFor, registerForge, sweepPendingSettles } from "./escrow.ts";
export type { ChainSubmitter, EscrowConfig, SettleReceipt } from "./escrow.ts";
export { InMemorySettleJournal, PostgresSettleJournal, InMemoryIntentJournal, PostgresIntentJournal } from "./journal.ts";
export type { PendingSettle, SettleJournal, SettleIntent, IntentJournal } from "./journal.ts";
export { stellarPay } from "./pay.ts";
export { isEvmAddr, verifyScheme, dualVerify } from "./verify.ts";
export { FakeVerifier, FacilitatorVerifier, EvmFacilitatorVerifier } from "./verifier.ts";
export type { PaymentRequirements, PaymentVerifier, SettleResult } from "./verifier.ts";
// — Seam EVM (Monad, ADR-0008) —
export {
  EvmSubmitter,
  EvmEscrowSettlement,
  ESCROW_ABI,
  MONAD_USDC,
  MONAD_TESTNET_CHAIN_ID,
  evmSigner,
  evmVerify,
  evmForgeKeypair,
  evmResultHash,
  isTerminalEvmError,
  registerForgeEvm,
  sweepPendingEvm,
  reconcileEvmOrphans,
  FUNDED_TOPIC,
} from "./evm.ts";
export type { EvmSubmitterConfig, EvmEscrowConfig, EvmEscrowTransport, FundedJob } from "./evm.ts";
// — ERC-8004 identidad/reputación canónica (Monad) —
export {
  ERC8004_IDENTITY,
  ERC8004_REPUTATION,
  IDENTITY_ABI,
  REPUTATION_ABI,
  forgeAgentURI,
  registerAgent,
  readAgentOwner,
  giveFeedback,
  jobSettledFeedback,
} from "./erc8004.ts";
export type { FeedbackInput } from "./erc8004.ts";
