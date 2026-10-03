// Module Settlement — cliente x402 v2: construye el header X-PAYMENT con una
// autorización EIP-3009 `transferWithAuthorization` firmada. El facilitator
// ejecuta el cobro on-chain; el cliente jamás envía una tx (gasless).
import { randomBytes } from "node:crypto";
import type { PaymentRequirements } from "./verifier.ts";

export const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

type TypedDataArgs = {
  domain: { name: string; version: string; chainId: bigint; verifyingContract: `0x${string}` };
  types: typeof EIP3009_TYPES;
  primaryType: "TransferWithAuthorization";
  message: Record<string, unknown>;
};

export async function buildX402Eip3009Header(opts: {
  from: `0x${string}`;
  signTypedData: (args: TypedDataArgs) => Promise<`0x${string}`>;
  requirements: PaymentRequirements & { asset: string; amount: string };
  validSeconds?: number;
}): Promise<string> {
  const { from, signTypedData, requirements: req } = opts;
  const chainId = BigInt(req.network.split(":")[1]);
  const validBefore = Math.floor(Date.now() / 1000) + (opts.validSeconds ?? req.maxTimeoutSeconds ?? 300);
  const authorization = {
    from,
    to: req.payTo as `0x${string}`,
    value: req.amount,
    validAfter: "0",
    validBefore: String(validBefore),
    nonce: `0x${randomBytes(32).toString("hex")}` as `0x${string}`,
  };
  const domain = {
    name: (req.extra?.name as string) ?? "USDC",
    version: (req.extra?.version as string) ?? "2",
    chainId,
    verifyingContract: req.asset as `0x${string}`,
  };
  const signature = await signTypedData({
    domain,
    types: EIP3009_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: authorization.from,
      to: authorization.to,
      value: BigInt(authorization.value),
      validAfter: 0n,
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
  });
  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      scheme: req.scheme,
      network: req.network,
      accepted: req,
      payload: { signature, authorization },
    }),
  ).toString("base64");
}
