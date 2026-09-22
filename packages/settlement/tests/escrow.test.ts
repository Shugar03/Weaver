// S17b — settlement programático: fund + release por job, operador fondea.
// El submitter es seam: el test inyecta fake, prod inyecta RpcSubmitter (testnet).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { nativeToScVal, scValToNative } from "@stellar/stellar-sdk";
import { EscrowSettlement, type ChainSubmitter } from "../src/escrow.ts";
import type { xdr } from "@stellar/stellar-sdk";

const CONTRACT = "CDHD6QRVGY5XNX6XUUYVCGJ6PH476J4YQXOSLJXH3RIPDRPW4PXWSENB";
const OPERATOR = "GDQGSN4K3MEBNTYEOGFHAUPJAH6FMGSJC6W6K37RY43KMW44G3CP4SMA";
const WORKER = "GDWZGZBSGDM2522KDT4MZZ6MGDDBTIX2CPFLXZMWMCWOHAPARTUZJX6T";
const HASH = Buffer.alloc(32, 7);
const SIG = Buffer.alloc(64, 9);

function fakeSubmitter(calls: { fn: string; args?: xdr.ScVal[] }[], jobId = 7): ChainSubmitter {
  return {
    async invoke(_contract, fn, args) {
      calls.push({ fn, args });
      if (fn === "fund_job") return { txHash: "fund-tx", retval: nativeToScVal(jobId, { type: "u64" }) };
      return { txHash: "release-tx" };
    },
  };
}

describe("S17b escrow", () => {
  it("settleJob: fund → release en orden, receipt con jobId y txs", async () => {
    const calls: { fn: string; args?: xdr.ScVal[] }[] = [];
    const s = new EscrowSettlement(fakeSubmitter(calls, 7), {
      contractId: CONTRACT,
      operator: OPERATOR,
      worker: WORKER,
      payout: 100000,
    });
    const r = await s.settleJob(HASH, SIG);
    assert.deepEqual(calls.map((c) => c.fn), ["fund_job", "release"]);
    assert.deepEqual(r, { jobId: 7, fundTx: "fund-tx", releaseTx: "release-tx" });
  });

  it("S22/23: release lleva result_hash + forge_sig (BytesN<32> + BytesN<64>)", async () => {
    const calls: { fn: string; args?: xdr.ScVal[] }[] = [];
    const s = new EscrowSettlement(fakeSubmitter(calls), {
      contractId: CONTRACT,
      operator: OPERATOR,
      worker: WORKER,
      payout: 100000,
    });
    await s.settleJob(HASH, SIG);
    const releaseArgs = calls.find((c) => c.fn === "release")?.args;
    assert.equal(releaseArgs?.length, 5);
    assert.deepEqual(scValToNative(releaseArgs?.[3] as xdr.ScVal), new Uint8Array(HASH));
    assert.deepEqual(scValToNative(releaseArgs?.[4] as xdr.ScVal), new Uint8Array(SIG));
  });

  it("hash de largo distinto a 32 → throw antes de tocar la chain", async () => {
    const calls: { fn: string }[] = [];
    const s = new EscrowSettlement(fakeSubmitter(calls), {
      contractId: CONTRACT,
      operator: OPERATOR,
      worker: WORKER,
      payout: 100000,
    });
    await assert.rejects(() => s.settleJob(Buffer.alloc(8), SIG), /32 bytes/);
    await assert.rejects(() => s.settleJob(HASH, Buffer.alloc(8)), /64 bytes/);
    assert.equal(calls.length, 0);
  });

  it("falla fund → no hay release, throwea (el gateway marca failed)", async () => {
    const failing: ChainSubmitter = {
      async invoke() {
        throw new Error("rpc caído");
      },
    };
    const s = new EscrowSettlement(failing, { contractId: CONTRACT, operator: OPERATOR, worker: WORKER, payout: 100000 });
    await assert.rejects(() => s.settleJob(HASH, SIG), /rpc caído/);
  });
});
