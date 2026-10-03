// packages/settlement/tests/eip3009.test.ts — cliente x402: construye el
// X-PAYMENT EIP-3009 que el facilitator settlea on-chain. La firma se verifica
// con viem verifyTypedData (recupera el firmante real del typed data).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { verifyTypedData } from "viem";
import { buildX402Eip3009Header, EIP3009_TYPES } from "../src/eip3009.ts";

const USDC = "0x534b2f3A21130d7a60830c2Df862319e593943A3" as const;
const PAY_TO = "0xbaD8908CD47c0A47F31F35a45e5c8Ba14878aF3B" as const;

const REQS = {
  scheme: "exact" as const,
  network: "eip155:10143" as const,
  payTo: PAY_TO,
  asset: USDC,
  amount: "10000",
  resource: "https://weaver.network/v1/chat/completions",
  maxTimeoutSeconds: 60,
  extra: { name: "USDC", version: "2" },
};

describe("buildX402Eip3009Header", () => {
  it("produce un header v2 con signature+authorization verificables", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const header = await buildX402Eip3009Header({
      from: account.address,
      signTypedData: (args) => account.signTypedData(args as never),
      requirements: REQS,
    });

    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    assert.equal(decoded.x402Version, 2);
    assert.equal(decoded.scheme ?? decoded.accepted?.scheme, "exact");
    assert.equal(decoded.network ?? decoded.accepted?.network, "eip155:10143");

    const p = decoded.payload as {
      signature: `0x${string}`;
      authorization: {
        from: `0x${string}`; to: `0x${string}`; value: string;
        validAfter: string; validBefore: string; nonce: `0x${string}`;
      };
    };
    assert.ok(/^0x[0-9a-fA-F]{130}$/.test(p.signature), "firma 65B");
    assert.equal(p.authorization.from.toLowerCase(), account.address.toLowerCase());
    assert.equal(p.authorization.to.toLowerCase(), PAY_TO.toLowerCase());
    assert.equal(p.authorization.value, "10000");
    assert.equal(p.authorization.validAfter, "0");
    assert.ok(BigInt(p.authorization.validBefore) > BigInt(Math.floor(Date.now() / 1000)));
    assert.ok(/^0x[0-9a-fA-F]{64}$/.test(p.authorization.nonce), "nonce bytes32");

    // La firma recupera al from → el facilitator la aceptará para
    // transferWithAuthorization (mismo domain/types del token).
    const ok = await verifyTypedData({
      address: account.address,
      domain: { name: "USDC", version: "2", chainId: 10143n, verifyingContract: USDC },
      types: EIP3009_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: p.authorization.from,
        to: p.authorization.to,
        value: BigInt(p.authorization.value),
        validAfter: BigInt(p.authorization.validAfter),
        validBefore: BigInt(p.authorization.validBefore),
        nonce: p.authorization.nonce,
      },
      signature: p.signature,
    });
    assert.equal(ok, true);
  });

  it("nonce es único por header (replay-safe)", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const build = () =>
      buildX402Eip3009Header({
        from: account.address,
        signTypedData: (a) => account.signTypedData(a as never),
        requirements: REQS,
      });
    const [h1, h2] = [await build(), await build()];
    const n1 = (JSON.parse(Buffer.from(h1, "base64").toString()) as any).payload.authorization.nonce;
    const n2 = (JSON.parse(Buffer.from(h2, "base64").toString()) as any).payload.authorization.nonce;
    assert.notEqual(n1, n2);
  });

  it("echa los requirements en `accepted` (el facilitator valida el match)", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const header = await buildX402Eip3009Header({
      from: account.address,
      signTypedData: (a) => account.signTypedData(a as never),
      requirements: REQS,
    });
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    assert.equal(decoded.accepted.payTo, PAY_TO);
    assert.equal(decoded.accepted.asset, USDC);
    assert.equal(decoded.accepted.amount, "10000");
  });
});
