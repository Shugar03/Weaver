// EVM escrow (Monad, ADR-0008) — mismos casos que escrow.test.ts pero con el
// seam EVM: transporte fake, journal compartido, proofs secp256k1 reales.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EvmEscrowSettlement,
  evmForgeKeypair,
  evmResultHash,
  evmSigner,
  evmVerify,
  isTerminalEvmError,
  sweepPendingEvm,
  type EvmEscrowTransport,
} from "../src/evm.ts";
import { InMemorySettleJournal } from "../src/journal.ts";
import type { Address, Hex } from "viem";

const ESCROW = "0x51acE4858652D942dC7b320870e4CDbc5c989cD6" as Address;
const USDC = "0x534b2f3A21130d7a60830c2Df862319e593943A3" as Address;
const WORKER = "0xbaD8908CD47c0A47F31F35a45e5c8Ba14878aF3B" as Address;
const HASH = Buffer.alloc(32, 7);
const SIG65 = Buffer.alloc(65, 9);

type Call = { fn: string; args: unknown[] };

function fakeTransport(calls: Call[], jobId = 7): EvmEscrowTransport {
  return {
    async ensureAllowance(_t, _s, _a) {
      return null; // ya aprobado
    },
    async invoke(_contract, _abi, fn, args) {
      calls.push({ fn, args });
      if (fn === "fundJob") return { txHash: "0xfund" as Hex, retval: BigInt(jobId) };
      return { txHash: "0xrel" as Hex };
    },
  };
}

describe("EVM escrow — settleJob", () => {
  it("fundJob → release en orden, receipt con jobId y txs", async () => {
    const calls: Call[] = [];
    const s = new EvmEscrowSettlement(fakeTransport(calls, 7), {
      escrow: ESCROW,
      token: USDC,
      payout: 10_000,
    });
    const r = await s.settleJob(HASH, SIG65, WORKER);
    assert.deepEqual(calls.map((c) => c.fn), ["fundJob", "release"]);
    assert.deepEqual(r, { jobId: 7, fundTx: "0xfund", releaseTx: "0xrel" });
  });

  it("fundJob liga el worker (payout per-forge) y el amount", async () => {
    const calls: Call[] = [];
    const s = new EvmEscrowSettlement(fakeTransport(calls), {
      escrow: ESCROW,
      token: USDC,
      payout: 10_000,
    });
    await s.settleJob(HASH, SIG65, WORKER);
    const fund = calls.find((c) => c.fn === "fundJob");
    assert.deepEqual(fund?.args, [10_000n, WORKER]);
  });

  it("release lleva resultHash 0x-hex + forgeSig 0x-hex (32b/65b)", async () => {
    const calls: Call[] = [];
    const s = new EvmEscrowSettlement(fakeTransport(calls), {
      escrow: ESCROW,
      token: USDC,
      payout: 10_000,
    });
    await s.settleJob(HASH, SIG65, WORKER);
    const rel = calls.find((c) => c.fn === "release");
    assert.equal(rel?.args[0], 7n); // jobId
    assert.equal(rel?.args[1], `0x${HASH.toString("hex")}`);
    assert.equal(rel?.args[2], `0x${SIG65.toString("hex")}`);
  });

  it("release falla post-fund → job queda pending en el journal", async () => {
    const journal = new InMemorySettleJournal();
    let pendingNotified = 0;
    const flaky: EvmEscrowTransport = {
      async ensureAllowance() {
        return null;
      },
      async invoke(_c, _a, fn) {
        if (fn === "fundJob") return { txHash: "0xfund" as Hex, retval: 3n };
        throw new Error("RPC timeout");
      },
    };
    const s = new EvmEscrowSettlement(
      flaky,
      { escrow: ESCROW, token: USDC, payout: 10_000 },
      journal,
      () => pendingNotified++,
    );
    await assert.rejects(() => s.settleJob(HASH, SIG65, WORKER));
    const pend = await journal.pending();
    assert.equal(pend.length, 1);
    assert.equal(pend[0].jobId, 3);
    assert.equal(pendingNotified, 1);
  });

  it("hash ≠ 32B o sig ≠ 65B → throw antes de tocar la chain", async () => {
    const calls: Call[] = [];
    const s = new EvmEscrowSettlement(fakeTransport(calls), {
      escrow: ESCROW,
      token: USDC,
      payout: 10_000,
    });
    await assert.rejects(() => s.settleJob(Buffer.alloc(31), SIG65, WORKER), /32 bytes/);
    await assert.rejects(() => s.settleJob(HASH, Buffer.alloc(64), WORKER), /65 bytes/);
    assert.equal(calls.length, 0);
  });
});

describe("EVM proof L0 — evmSigner / evmVerify (secp256k1, offline)", () => {
  const SK = "0xd777e6cdff64decdcd304c06e1c2d0f29cdb03e695180f1bf5351a234bfffb9f" as Hex;
  const ADDR = "0x7c41eb4274b7e5C51e44BA01606d9Db403BBbebc" as Address;

  it("firma → verify true contra la address del forge; produce 65 bytes", async () => {
    const sign = evmSigner(SK);
    const sig = await sign(HASH);
    assert.equal(sig.length, 65);
    assert.equal(await evmVerify(ADDR, HASH, sig), true);
  });

  it("firma de OTRA key / hash distinto / sig cortada → false, jamás throw", async () => {
    const sign = evmSigner(SK);
    const sig = await sign(HASH);
    const other = evmForgeKeypair(`0x${"99".repeat(32)}` as Hex);
    assert.equal(await evmVerify(other.address, HASH, sig), false);
    assert.equal(await evmVerify(ADDR, Buffer.alloc(32, 8), sig), false);
    assert.equal(await evmVerify(ADDR, HASH, sig.subarray(0, 40)), false);
    assert.equal(await evmVerify(ADDR, HASH, Buffer.alloc(0)), false);
  });

  it("evmResultHash = keccak256 del output servido", () => {
    assert.equal(
      evmResultHash(Buffer.from("weaver-gen0-demo-result")).toString("hex"),
      "6948cc5c41ac8d31762de5d69f40405e701adafb38c219d7c6b7cf77344e6561",
    );
  });
});

describe("sweepPendingEvm — recovery post-crash", () => {
  function j(jobId: number) {
    return {
      jobId,
      worker: WORKER,
      resultHash: "aa".repeat(32),
      forgeSig: "bb".repeat(65),
      fundTx: "0xfund",
      createdAt: Date.now(),
    };
  }

  it("pending + release ok → released, sale del pending", async () => {
    const journal = new InMemorySettleJournal();
    await journal.record(j(5));
    const ok = { async invoke() { return { txHash: "0xrel" as Hex }; } };
    const r = await sweepPendingEvm(ok, journal, ESCROW);
    assert.deepEqual(r, { released: 1, failed: 0 });
    assert.equal((await journal.pending()).length, 0);
  });

  it("error transitorio → sigue pending, NO failed", async () => {
    const journal = new InMemorySettleJournal();
    await journal.record(j(5));
    const flaky = { async invoke() { throw new Error("nonce too low, retry"); } };
    const r = await sweepPendingEvm(flaky, journal, ESCROW);
    assert.deepEqual(r, { released: 0, failed: 0 });
    assert.equal((await journal.pending()).length, 1);
  });

  it("error terminal del contrato (BadSignature) → failed y sale", async () => {
    const journal = new InMemorySettleJournal();
    await journal.record(j(5));
    const bad = { async invoke() { throw new Error("execution reverted: BadSignature()"); } };
    const r = await sweepPendingEvm(bad, journal, ESCROW);
    assert.deepEqual(r, { released: 0, failed: 1 });
    assert.equal((await journal.pending()).length, 0);
  });

  it("isTerminalEvmError: errores del enum → terminal, RPC → transitorio", () => {
    assert.equal(isTerminalEvmError(new Error("execution reverted: BadState()")), true);
    assert.equal(isTerminalEvmError(new Error("execution reverted: Unauthorized()")), true);
    assert.equal(isTerminalEvmError(new Error("fetch failed: ECONNREFUSED")), false);
    assert.equal(isTerminalEvmError(new Error("replacement transaction underpriced")), false);
  });
});
