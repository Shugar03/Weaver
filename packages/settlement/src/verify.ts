// Verify dual de forges: el wire (pubkey, msg, sig) es agnóstico a la chain —
// la pubkey decide el esquema. Una fleet mixta Stellar+EVM convive sin config:
// G… → ed25519 sync, 0x… → ecrecover async. Ambas fail-closed.
import type { Address } from "viem";
import { stellarVerify } from "./escrow.ts";
import { evmVerify } from "./evm.ts";

export const isEvmAddr = (pk: string): pk is Address => /^0x[0-9a-fA-F]{40}$/.test(pk);

// Devuelve el esquema detectado o null si la pubkey no parsea a ninguno —
// "unknown" también es fail-closed (un pubkey basura jamás verifica).
export function verifyScheme(pk: string): "stellar" | "evm" | null {
  if (isEvmAddr(pk)) return "evm";
  if (/^G[A-Z2-7]{55}$/.test(pk)) return "stellar";
  return null;
}

export function dualVerify(pk: string, msg: Buffer, sig: Buffer): boolean | Promise<boolean> {
  const s = verifyScheme(pk);
  if (s === "evm") return evmVerify(pk as Address, msg, sig);
  if (s === "stellar") return stellarVerify(pk, msg, sig);
  return false;
}
