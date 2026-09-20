// S17b — settlement programático: fund + release por job, operador fondea.
// El submitter es seam: el test inyecta fake, prod inyecta RpcSubmitter (testnet).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { nativeToScVal } from "@stellar/stellar-sdk";
import { EscrowSettlement, type ChainSubmitter } from "../src/escrow.ts";

const CONTRACT = "CDPOGSQLTLRZPCE2NF4WFVSMGQEGLOAPBM5LFCK2U26LP6B5YVN5GBU3";
const OPERATOR = "GDQGSN4K3MEBNTYEOGFHAUPJAH6FMGSJC6W6K37RY43KMW44G3CP4SMA";
const WORKER = "GDWZGZBSGDM2522KDT4MZZ6MGDDBTIX2CPFLXZMWMCWOHAPARTUZJX6T";

function fakeSubmitter(calls: { fn: string }[], jobId = 7): ChainSubmitter {
  return {
    async invoke(_contract, fn, _args) {
      calls.push({ fn });
      if (fn === "fund_job") return { txHash: "fund-tx", retval: nativeToScVal(jobId, { type: "u64" }) };
      return { txHash: "release-tx" };
    },
  };
}

describe("S17b escrow", () => {
  it("settleJob: fund → release en orden, receipt con jobId y txs", async () => {
    const calls: { fn: string }[] = [];
    const s = new EscrowSettlement(fakeSubmitter(calls, 7), {
      contractId: CONTRACT,
      operator: OPERATOR,
      worker: WORKER,
      payout: 100000,
    });
    const r = await s.settleJob();
    assert.deepEqual(calls.map((c) => c.fn), ["fund_job", "release"]);
    assert.deepEqual(r, { jobId: 7, fundTx: "fund-tx", releaseTx: "release-tx" });
  });

  it("falla fund → no hay release, throwea (el gateway marca failed)", async () => {
    const failing: ChainSubmitter = {
      async invoke() {
        throw new Error("rpc caído");
      },
    };
    const s = new EscrowSettlement(failing, { contractId: CONTRACT, operator: OPERATOR, worker: WORKER, payout: 100000 });
    await assert.rejects(() => s.settleJob(), /rpc caído/);
  });
});
