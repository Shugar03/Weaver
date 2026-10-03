// Module Settlement — ERC-8004 en Monad (ADR-0008, track 04): identidad y
// reputación canónicas de los forges. Los singletons ya están deployados —
// acá solo se llama. Cada forge registra su propio agentId (owner = su wallet,
// no la plataforma) y el gateway emite feedback tras cada release: la prueba
// de pago on-chain es la evidencia del feedback.
import type { Address, Hex } from "viem";
import type { EvmSubmitter } from "./evm.ts";
import type { SettleReceipt } from "./escrow.ts";

// Singletons oficiales ERC-8004 en Monad testnet (chain 10143, impl v2.0.0)
export const ERC8004_IDENTITY = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as Address;
export const ERC8004_REPUTATION = "0x8004B663056A597Dffe9eCcC1965A193B7388713" as Address;

export const IDENTITY_ABI = [
  {
    type: "function",
    name: "register",
    stateMutability: "nonpayable",
    inputs: [{ name: "agentURI", type: "string" }],
    outputs: [{ name: "agentId", type: "uint256" }],
  },
  {
    type: "function",
    name: "setAgentURI",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "newURI", type: "string" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setMetadata",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "metadataKey", type: "string" },
      { name: "metadataValue", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

export const REPUTATION_ABI = [
  {
    type: "function",
    name: "giveFeedback",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "value", type: "int128" },
      { name: "valueDecimals", type: "uint8" },
      { name: "tag1", type: "string" },
      { name: "tag2", type: "string" },
      { name: "endpoint", type: "string" },
      { name: "feedbackURI", type: "string" },
      { name: "feedbackHash", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getSummary",
    stateMutability: "view",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "clientAddresses", type: "address[]" },
      { name: "tag1", type: "string" },
      { name: "tag2", type: "string" },
    ],
    outputs: [
      { name: "count", type: "uint64" },
      { name: "summaryValue", type: "int128" },
      { name: "summaryValueDecimals", type: "uint8" },
    ],
  },
] as const;

type Invoker = Pick<EvmSubmitter, "invoke">;

// Registration file ERC-8004 embebida en un data URI: cero infra (sin IPFS
// ni hosting), el URI queda on-chain íntegro. Nada de datos de prompts —
// solo identidad pública del forge.
export function forgeAgentURI(forge: {
  name: string;
  model: string;
  worker: Address;
  endpoint?: string;
  escrow?: Address;
}): string {
  const doc = {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: forge.name,
    description: `Weaver forge — measured ETR inference worker (${forge.model}). Settles per-job on WeaverEscrow.`,
    services: forge.endpoint ? [{ name: "A2A", endpoint: forge.endpoint }] : [],
    registrations: [{ agentId: 0, agentRegistry: `eip155:10143:${ERC8004_IDENTITY}` }],
    supportedTrust: ["reputation", "crypto-economic"],
    weaver: { worker: forge.worker, model: forge.model, escrow: forge.escrow },
  };
  return `data:application/json;base64,${Buffer.from(JSON.stringify(doc)).toString("base64")}`;
}

// register(agentURI) → agentId (el caller queda owner del NFT — el FORGE se
// registra a sí mismo, no la plataforma).
export async function registerAgent(
  submitter: Invoker,
  agentURI: string,
): Promise<{ agentId: bigint; txHash: Hex }> {
  const { txHash, retval } = await submitter.invoke(ERC8004_IDENTITY, IDENTITY_ABI, "register", [agentURI]);
  if (retval === undefined) throw new Error(`register no devolvió agentId: ${txHash}`);
  return { agentId: retval, txHash };
}

export type FeedbackInput = {
  agentId: bigint;
  value: bigint; // int128
  valueDecimals?: number; // 0-18, default 0
  tag1?: string;
  tag2?: string;
  endpoint?: string;
  feedbackURI?: string;
  feedbackHash?: Hex; // keccak256 del JSON en feedbackURI, 0x00… si vacío
};

// giveFeedback — el gateway (cliente del forge) emite reputación. El registry
// revierte self-feedback: owner/operator del agentId no puede calificarse.
export async function giveFeedback(submitter: Invoker, f: FeedbackInput): Promise<Hex> {
  const { txHash } = await submitter.invoke(ERC8004_REPUTATION, REPUTATION_ABI, "giveFeedback", [
    f.agentId,
    f.value,
    f.valueDecimals ?? 0,
    f.tag1 ?? "",
    f.tag2 ?? "",
    f.endpoint ?? "",
    f.feedbackURI ?? "",
    f.feedbackHash ?? "0x0000000000000000000000000000000000000000000000000000000000000000",
  ]);
  return txHash;
}

// Feedback post-release: la evidencia es el propio recibo del escrow —
// jobId + fundTx + releaseTx + resultHash viajan en un data URI; cualquiera
// puede re-verificar el pago on-chain desde el feedback.
export function jobSettledFeedback(
  receipt: SettleReceipt,
  opts: { agentId: bigint; model?: string; endpoint?: string; resultHash?: Buffer },
): FeedbackInput {
  const evidence = JSON.stringify({
    jobId: receipt.jobId,
    fundTx: receipt.fundTx,
    releaseTx: receipt.releaseTx,
    resultHash: opts.resultHash ? `0x${opts.resultHash.toString("hex")}` : undefined,
  });
  return {
    agentId: opts.agentId,
    value: 1n, // 1 job liquidado — el agregado del summary da el total
    valueDecimals: 0,
    tag1: "jobSettled",
    tag2: opts.model ?? "",
    endpoint: opts.endpoint ?? "",
    feedbackURI: `data:application/json,${encodeURIComponent(evidence)}`,
    feedbackHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
  };
}
