// MetaMask Delegation Toolkit (ERC-7710 / ERC-7715) — Agent Delegation with Caveats
// Permite al usuario final delegar un presupuesto acotado de micro-gastos (USDC)
// a un agente autónomo o forge para ejecutar inferencias y liquidar en WeaverEscrow sin popups.
//
// Direcciones canónicas del Delegation Framework v1.3.0 en Monad testnet —
// deploys deterministas CREATE2, mismas en todas las chains
// (delegation-framework/documents/Deployments.md). Los terms de cada caveat
// usan encodePacked, NO abi.encode — los enforcer on-chain los decodifican
// por slicing de bytes (ver getTermsInfo de cada contrato).
import {
  type Address,
  type Hash,
  type Hex,
  concat,
  toHex,
  hashTypedData,
  verifyTypedData,
  isAddressEqual,
} from "viem";

export type { Address, Hash, Hex };

export interface Caveat {
  enforcer: Address;
  terms: Hex;
  args?: Hex;
}

export interface Delegation {
  delegate: Address;
  delegator: Address;
  authority: Hash;
  caveats: Caveat[];
  salt: bigint;
  signature?: Hex;
}

export interface ExecutionRequest {
  target: Address;
  value: bigint;
  data?: Hex;
  timestamp?: number;
}

export const ROOT_AUTHORITY: Hash = "0x0000000000000000000000000000000000000000000000000000000000000000";

// — Canonical Delegation Framework v1.3.0 (Monad testnet, chain 10143) —
export const DELEGATION_MANAGER: Address = "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3";
export const ENFORCER_ERC20_TRANSFER_AMOUNT: Address = "0xf100b0819427117EcF76Ed94B358B1A5b5C6D2Fc";
export const ENFORCER_ALLOWED_TARGETS: Address = "0x7F20f61b1f09b08D970938F6fa563634d65c4EeB";
export const ENFORCER_ALLOWED_METHODS: Address = "0x2c21fD0Cb9DC8445CB3fb0DC5E7Bb0Aca01842B5";
export const ENFORCER_TIMESTAMP: Address = "0x1046bb45C8d673d4ea75321280DB34899413c069";
export const ENFORCER_LIMITED_CALLS: Address = "0x04658B29F6b82ed55274221a06Fc97D318E25416";

// EIP-712 domain del DelegationManager real (NAME="DelegationManager",
// DOMAIN_VERSION="1" — src/DelegationManager.sol v1.3.0).
export const DELEGATION_DOMAIN = (chainId: number = 10143) => ({
  name: "DelegationManager",
  version: "1",
  chainId,
  verifyingContract: DELEGATION_MANAGER,
});

export const DELEGATION_TYPES = {
  Delegation: [
    { name: "delegate", type: "address" },
    { name: "delegator", type: "address" },
    { name: "authority", type: "bytes32" },
    { name: "caveats", type: "Caveat[]" },
    { name: "salt", type: "uint256" },
  ],
  Caveat: [
    { name: "enforcer", type: "address" },
    { name: "terms", type: "bytes" },
  ],
} as const;

// — Terms encodePacked (formato on-chain real de cada enforcer) —

// ERC20TransferAmountEnforcer: token[20] ‖ maxAmount[32] = 52 bytes exactos.
// El enforcer solo valida executions `transfer(to, amount)` sobre ese token.
export function encodeErc20TransferAmountTerms(token: Address, maxAmount: bigint): Hex {
  return concat([token, toHex(maxAmount, { size: 32 })]);
}
export function decodeErc20TransferAmountTerms(terms: Hex): { token: Address; maxAmount: bigint } {
  if (terms.length !== 106) throw new Error(`ERC20TransferAmount terms debe ser 52B, vino ${(terms.length - 2) / 2}B`);
  return {
    token: `0x${terms.slice(2, 42)}` as Address,
    maxAmount: BigInt(`0x${terms.slice(42)}`),
  };
}

// AllowedTargetsEnforcer: addresses de 20B concatenadas (len % 20 == 0, != 0).
export function encodeAllowedTargetsTerms(targets: Address[]): Hex {
  if (targets.length === 0) throw new Error("AllowedTargets requiere ≥1 target");
  return concat(targets);
}
export function decodeAllowedTargetsTerms(terms: Hex): Address[] {
  const body = terms.slice(2);
  if (body.length === 0 || body.length % 40 !== 0)
    throw new Error(`AllowedTargets terms debe ser N×20B, vino ${body.length / 2}B`);
  const out: Address[] = [];
  for (let i = 0; i < body.length; i += 40) out.push(`0x${body.slice(i, i + 40)}` as Address);
  return out;
}

// AllowedMethodsEnforcer: selectors de 4B concatenados (len % 4 == 0, != 0).
export function encodeAllowedMethodsTerms(selectors: Hex[]): Hex {
  if (selectors.length === 0) throw new Error("AllowedMethods requiere ≥1 selector");
  for (const s of selectors) if (s.length !== 10) throw new Error(`selector debe ser 4B: ${s}`);
  return concat(selectors);
}
export function decodeAllowedMethodsTerms(terms: Hex): Hex[] {
  const body = terms.slice(2);
  if (body.length === 0 || body.length % 8 !== 0)
    throw new Error(`AllowedMethods terms debe ser N×4B, vino ${body.length / 2}B`);
  const out: Hex[] = [];
  for (let i = 0; i < body.length; i += 8) out.push(`0x${body.slice(i, i + 8)}` as Hex);
  return out;
}

// TimestampEnforcer: 32B = uint128 afterThreshold ‖ uint128 beforeThreshold.
// Umbrales exclusivos: válido si after < block.timestamp < before; 0 = sin límite.
export function encodeTimestampTerms(after: number, before: number): Hex {
  return toHex((BigInt(after) << 128n) | BigInt(before), { size: 32 });
}
export function decodeTimestampTerms(terms: Hex): { after: number; before: number } {
  if (terms.length !== 66) throw new Error(`Timestamp terms debe ser 32B, vino ${(terms.length - 2) / 2}B`);
  const v = BigInt(terms);
  return { after: Number(v >> 128n), before: Number(v & ((1n << 128n) - 1n)) };
}

// LimitedCallsEnforcer: uint256 limit = 32B.
export function encodeLimitedCallsTerms(limit: bigint): Hex {
  return toHex(limit, { size: 32 });
}
export function decodeLimitedCallsTerms(terms: Hex): bigint {
  if (terms.length !== 66) throw new Error(`LimitedCalls terms debe ser 32B, vino ${(terms.length - 2) / 2}B`);
  return BigInt(terms);
}

// — Hasheo y verificación EIP-712 —

export function hashDelegation(delegation: Delegation, chainId: number = 10143): Hash {
  return hashTypedData({
    domain: DELEGATION_DOMAIN(chainId),
    types: DELEGATION_TYPES,
    primaryType: "Delegation",
    message: {
      delegate: delegation.delegate,
      delegator: delegation.delegator,
      authority: delegation.authority,
      caveats: delegation.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms })),
      salt: delegation.salt,
    },
  });
}

export async function verifyDelegationSignature(
  delegation: Delegation,
  chainId: number = 10143
): Promise<boolean> {
  if (!delegation.signature) return false;
  try {
    return await verifyTypedData({
      address: delegation.delegator,
      domain: DELEGATION_DOMAIN(chainId),
      types: DELEGATION_TYPES,
      primaryType: "Delegation",
      message: {
        delegate: delegation.delegate,
        delegator: delegation.delegator,
        authority: delegation.authority,
        caveats: delegation.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms })),
        salt: delegation.salt,
      },
      signature: delegation.signature,
    });
  } catch {
    return false;
  }
}

// Helper de conveniencia para construir la delegación del agente Weaver:
// presupuesto USDC acotado + targets restringidos (escrow/credits) + ventana
// temporal + tope de ejecuciones.
export function buildWeaverAgentDelegation(params: {
  delegator: Address;
  agent: Address;
  expiresAt: number;
  allowedTargets: Address[];
  // Presupuesto ERC20 opcional: si usdc+maxAmount están, TODA ejecución debe
  // ser transfer() sobre ese token (el enforcer on-chain revierte lo demás).
  // Delegaciones para calls de contrato van sin presupuesto ERC20.
  usdc?: Address;
  maxAmount?: bigint;
  validAfter?: number;
  allowedSelectors?: Hex[];
  maxCalls?: bigint;
  salt?: bigint;
}): Delegation {
  const caveats: Caveat[] = [];
  if (params.usdc && params.maxAmount !== undefined) {
    caveats.push({
      enforcer: ENFORCER_ERC20_TRANSFER_AMOUNT,
      terms: encodeErc20TransferAmountTerms(params.usdc, params.maxAmount),
    });
  }
  caveats.push(
    {
      enforcer: ENFORCER_ALLOWED_TARGETS,
      terms: encodeAllowedTargetsTerms(params.allowedTargets),
    },
    {
      enforcer: ENFORCER_TIMESTAMP,
      terms: encodeTimestampTerms(params.validAfter ?? 0, params.expiresAt),
    },
  );

  if (params.allowedSelectors && params.allowedSelectors.length > 0) {
    caveats.push({
      enforcer: ENFORCER_ALLOWED_METHODS,
      terms: encodeAllowedMethodsTerms(params.allowedSelectors),
    });
  }
  if (params.maxCalls !== undefined) {
    caveats.push({
      enforcer: ENFORCER_LIMITED_CALLS,
      terms: encodeLimitedCallsTerms(params.maxCalls),
    });
  }

  return {
    delegate: params.agent,
    delegator: params.delegator,
    authority: ROOT_AUTHORITY,
    caveats,
    salt: params.salt ?? BigInt(Math.floor(Date.now() * 1000 + Math.random() * 1000)),
  };
}

// Espejo OFF-CHAIN de los enforcers canónicos: valida una ejecución contra las
// mismas reglas antes de enviarla on-chain (la enforcement real vive en el
// DelegationManager — esto evita un round-trip revertido y da errores
// legibles). Acumula gasto por delegationHash como spentMap del enforcer.
export class DelegationEngine {
  private readonly spent = new Map<string, bigint>();
  private readonly calls = new Map<string, bigint>();

  public getSpent(delegationHash: string): bigint {
    return this.spent.get(delegationHash) ?? 0n;
  }

  async validateAndExecute(
    delegation: Delegation,
    request: ExecutionRequest,
    options?: { currentTimestamp?: number; chainId?: number; checkSignature?: boolean }
  ): Promise<{ success: boolean; error?: string; remainingAllowance?: bigint }> {
    const chainId = options?.chainId ?? 10143;
    const now = options?.currentTimestamp ?? Math.floor(Date.now() / 1000);

    if (delegation.signature && options?.checkSignature !== false) {
      const valid = await verifyDelegationSignature(delegation, chainId);
      if (!valid) {
        return { success: false, error: "invalid_signature" };
      }
    }

    const dHash = hashDelegation(delegation, chainId);
    let transferCap: { token: Address; maxAmount: bigint } | null = null;

    for (const caveat of delegation.caveats) {
      if (isAddressEqual(caveat.enforcer, ENFORCER_ALLOWED_TARGETS)) {
        const allowedTargets = decodeAllowedTargetsTerms(caveat.terms);
        const isAllowed = allowedTargets.some((target) => isAddressEqual(target, request.target));
        if (!isAllowed) {
          return { success: false, error: "target_not_allowed" };
        }
      } else if (isAddressEqual(caveat.enforcer, ENFORCER_TIMESTAMP)) {
        const { after, before } = decodeTimestampTerms(caveat.terms);
        // Semántica on-chain: umbrales exclusivos, 0 = sin límite.
        if (after > 0 && now <= after) {
          return { success: false, error: "delegation_not_yet_valid" };
        }
        if (before > 0 && now >= before) {
          return { success: false, error: "delegation_expired" };
        }
      } else if (isAddressEqual(caveat.enforcer, ENFORCER_ALLOWED_METHODS)) {
        if (request.data) {
          const allowedSelectors = decodeAllowedMethodsTerms(caveat.terms).map((s) =>
            s.toLowerCase()
          );
          const methodSelector = request.data.slice(0, 10).toLowerCase();
          if (!allowedSelectors.includes(methodSelector)) {
            return { success: false, error: "method_not_allowed" };
          }
        }
      } else if (isAddressEqual(caveat.enforcer, ENFORCER_ERC20_TRANSFER_AMOUNT)) {
        transferCap = decodeErc20TransferAmountTerms(caveat.terms);
      } else if (isAddressEqual(caveat.enforcer, ENFORCER_LIMITED_CALLS)) {
        const limit = decodeLimitedCallsTerms(caveat.terms);
        const next = (this.calls.get(dHash) ?? 0n) + 1n;
        if (next > limit) {
          return { success: false, error: "calls_limit_exceeded" };
        }
        this.calls.set(dHash, next);
      }
    }

    // ERC20TransferAmount: el execution debe ser transfer() sobre el token
    // del caveat — el monto se lee del calldata (callData[36:68]), igual
    // que el enforcer on-chain.
    if (transferCap !== null) {
      const selector = request.data?.slice(0, 10).toLowerCase();
      if (!isAddressEqual(request.target, transferCap.token) || selector !== "0xa9059cbb") {
        return { success: false, error: "not_a_token_transfer" };
      }
      const amount = request.data && request.data.length >= 138
        ? BigInt(`0x${request.data.slice(74, 138)}`)
        : 0n;
      const nextSpent = (this.spent.get(dHash) ?? 0n) + amount;
      if (nextSpent > transferCap.maxAmount) {
        return { success: false, error: "spending_limit_exceeded" };
      }
      this.spent.set(dHash, nextSpent);
      return { success: true, remainingAllowance: transferCap.maxAmount - nextSpent };
    }

    return { success: true };
  }
}
