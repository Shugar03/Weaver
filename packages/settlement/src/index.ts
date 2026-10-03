// Module Settlement — única superficie pública.
export { JOB_PRICE_USDC } from "./ports.ts";
export { EscrowSettlement, RpcSubmitter, stellarSigner, stellarVerify, stellarPubkey, stellarKeypair, payoutFor, registerForge, sweepPendingSettles } from "./escrow.ts";
export type { ChainSubmitter, EscrowConfig, SettleReceipt } from "./escrow.ts";
export { InMemorySettleJournal, PostgresSettleJournal, InMemoryIntentJournal, PostgresIntentJournal, PostgresScanCursor } from "./journal.ts";
export type { PendingSettle, SettleJournal, SettleIntent, IntentJournal } from "./journal.ts";
export { stellarPay } from "./pay.ts";
export { isEvmAddr, verifyScheme, dualVerify } from "./verify.ts";
export { FakeVerifier, FacilitatorVerifier, EvmFacilitatorVerifier } from "./verifier.ts";
export { buildX402Eip3009Header, EIP3009_TYPES } from "./eip3009.ts";
export { SettleDispatcher } from "./dispatch.ts";
export type { SettleVia } from "./dispatch.ts";
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
  createEvmReconciler,
  InMemoryScanCursor,
  REORG_OVERLAP_BLOCKS,
  FUNDED_TOPIC,
} from "./evm.ts";
export type { EvmSubmitterConfig, EvmEscrowConfig, EvmEscrowTransport, FundedJob, ScanCursor, ReconcileRunResult } from "./evm.ts";
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
// — MetaMask Delegation Toolkit (ERC-7710/7715, canonical v1.3.0) —
export {
  DelegationEngine,
  buildWeaverAgentDelegation,
  verifyDelegationSignature,
  hashDelegation,
  encodeErc20TransferAmountTerms,
  decodeErc20TransferAmountTerms,
  encodeAllowedTargetsTerms,
  decodeAllowedTargetsTerms,
  encodeAllowedMethodsTerms,
  decodeAllowedMethodsTerms,
  encodeTimestampTerms,
  decodeTimestampTerms,
  encodeLimitedCallsTerms,
  decodeLimitedCallsTerms,
  DELEGATION_DOMAIN,
  DELEGATION_TYPES,
  DELEGATION_MANAGER,
  ENFORCER_ERC20_TRANSFER_AMOUNT,
  ENFORCER_ALLOWED_TARGETS,
  ENFORCER_ALLOWED_METHODS,
  ENFORCER_TIMESTAMP,
  ENFORCER_LIMITED_CALLS,
  ROOT_AUTHORITY,
} from "./delegation.ts";
export type { Caveat, Delegation, ExecutionRequest } from "./delegation.ts";
