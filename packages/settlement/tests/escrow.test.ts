// S17b — settlement programático: fund + release por job, operador fondea.
// El submitter es seam: el test inyecta fake, prod inyecta RpcSubmitter (testnet).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { nativeToScVal, scValToNative } from "@stellar/stellar-sdk";
import { EscrowSettlement, isTerminalReleaseError, payoutFor, stellarVerify, sweepPendingSettles, type ChainSubmitter } from "../src/escrow.ts";
import { InMemorySettleJournal } from "../src/journal.ts";
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
    // S42: release ya no recibe worker — sale del job (ligado en fund_job).
    assert.equal(releaseArgs?.length, 4);
    assert.deepEqual(scValToNative(releaseArgs?.[2] as xdr.ScVal), new Uint8Array(HASH));
    assert.deepEqual(scValToNative(releaseArgs?.[3] as xdr.ScVal), new Uint8Array(SIG));
  });

  it("S34/S42: workerAddr liga el job en fund_job — payout per-forge", async () => {
    const calls: { fn: string; args?: xdr.ScVal[] }[] = [];
    const s = new EscrowSettlement(fakeSubmitter(calls), {
      contractId: CONTRACT,
      operator: OPERATOR,
      worker: WORKER,
      payout: 100000,
    });
    const REMOTO = "GAVV65LL4DXUMHSRNEXPU576LSYLORL4MLZJI7KDGAALCSIDOKRVJG5B";
    await s.settleJob(HASH, SIG, REMOTO);
    const fundArgs = calls.find((c) => c.fn === "fund_job")?.args;
    assert.equal(scValToNative(fundArgs?.[2] as xdr.ScVal), REMOTO);
    // Sin override: cfg.worker como antes.
    calls.length = 0;
    await s.settleJob(HASH, SIG);
    const def = calls.find((c) => c.fn === "fund_job")?.args;
    assert.equal(scValToNative(def?.[2] as xdr.ScVal), WORKER);
  });

  it("S44: release falla post-fund → el job queda pending en el journal", async () => {
    const calls: { fn: string; args?: xdr.ScVal[] }[] = [];
    const journal = new InMemorySettleJournal();
    const flaky: ChainSubmitter = {
      async invoke(_c, fn, args) {
        calls.push({ fn, args });
        if (fn === "release") throw new Error("rpc cayó entre fund y release");
        return { txHash: "fund-tx", retval: nativeToScVal(9, { type: "u64" }) };
      },
    };
    const s = new EscrowSettlement(flaky, { contractId: CONTRACT, operator: OPERATOR, worker: WORKER, payout: 100000 }, journal);
    await assert.rejects(() => s.settleJob(HASH, SIG), /rpc cayó/);
    const pend = await journal.pending();
    assert.equal(pend.length, 1); // I3: la plata fondeada tiene referencia durable
    assert.equal(pend[0].jobId, 9);
    assert.equal(pend[0].resultHash, HASH.toString("hex"));
  });

  it("S44: release ok → journal markReleased (pending vacío)", async () => {
    const calls: { fn: string; args?: xdr.ScVal[] }[] = [];
    const journal = new InMemorySettleJournal();
    const s = new EscrowSettlement(fakeSubmitter(calls), { contractId: CONTRACT, operator: OPERATOR, worker: WORKER, payout: 100000 }, journal);
    await s.settleJob(HASH, SIG);
    assert.equal((await journal.pending()).length, 0);
  });

  it("S45: stats.genTokens medidos → payout = base + tokens×rate", async () => {
    const calls: { fn: string; args?: xdr.ScVal[] }[] = [];
    const s = new EscrowSettlement(fakeSubmitter(calls), {
      contractId: CONTRACT, operator: OPERATOR, worker: WORKER, payout: 100000, perToken: 100,
    });
    await s.settleJob(HASH, SIG);
    let fundArgs = calls.find((c) => c.fn === "fund_job")?.args;
    assert.equal(scValToNative(fundArgs?.[1] as xdr.ScVal), 100000n); // base, 0 tokens
    calls.length = 0;
    await s.settleJob(HASH, SIG, undefined, { genTokens: 500 });
    fundArgs = calls.find((c) => c.fn === "fund_job")?.args;
    assert.equal(scValToNative(fundArgs?.[1] as xdr.ScVal), 150000n); // 0.01 + 500×100
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

// S32 — stellarVerify: el handshake del forge firma el nonce con su secret;
// el gateway verifica con el pubkey. Nunca throw por input remoto.
describe("S32 stellarVerify", () => {
  it("firma válida del secret → verify true con el pubkey", async () => {
    const { Keypair } = await import("@stellar/stellar-sdk");
    const kp = Keypair.random();
    const msg = Buffer.from("nonce-de-challenge", "utf8");
    const sig = Buffer.from(kp.sign(msg));
    assert.equal(stellarVerify(kp.publicKey(), msg, sig), true);
  });

  it("firma de OTRA key / msg distinto / pubkey inválido → false", async () => {
    const { Keypair } = await import("@stellar/stellar-sdk");
    const kp = Keypair.random();
    const msg = Buffer.from("nonce", "utf8");
    const sig = Buffer.from(kp.sign(msg));
    assert.equal(stellarVerify(kp.publicKey(), Buffer.from("otro"), sig), false);
    assert.equal(stellarVerify(Keypair.random().publicKey(), msg, sig), false);
    assert.equal(stellarVerify("GNOEXXX", msg, sig), false);
    assert.equal(stellarVerify(kp.publicKey(), msg, Buffer.alloc(64)), false);
  });
});

describe("S44 sweepPendingSettles", () => {
  const row = {
    jobId: 9,
    worker: WORKER,
    resultHash: HASH.toString("hex"),
    forgeSig: SIG.toString("hex"),
    fundTx: "fund-tx",
    createdAt: Date.now(),
  };

  it("pending + release ok → released y sale del pending", async () => {
    const j = new InMemorySettleJournal();
    await j.record(row);
    const calls: { fn: string }[] = [];
    const r = await sweepPendingSettles(
      { async invoke(_c, fn) { calls.push({ fn }); return { txHash: "rel-tx" }; } },
      j, CONTRACT, OPERATOR,
    );
    assert.deepEqual(r, { released: 1, failed: 0 });
    assert.deepEqual(calls.map((c) => c.fn), ["release"]);
    assert.equal((await j.pending()).length, 0);
  });

  it("error transitorio (timeout RPC) → sigue pending, NO failed", async () => {
    const j = new InMemorySettleJournal();
    await j.record(row);
    const r = await sweepPendingSettles(
      { async invoke() { throw new Error("tx timeout polling"); } },
      j, CONTRACT, OPERATOR,
    );
    assert.deepEqual(r, { released: 0, failed: 0 });
    assert.equal((await j.pending()).length, 1); // reintentable en el próximo boot
  });

  it("error terminal del contrato (BadState) → failed y sale del pending", async () => {
    const j = new InMemorySettleJournal();
    await j.record(row);
    const r = await sweepPendingSettles(
      { async invoke() { throw new Error("HostError: Error(Contract, #4 BadState)"); } },
      j, CONTRACT, OPERATOR,
    );
    assert.deepEqual(r, { released: 0, failed: 1 });
    assert.equal((await j.pending()).length, 0);
  });

  it("isTerminalReleaseError clasifica los errores del enum del contrato", () => {
    for (const e of ["BadState", "Unauthorized", "ForgeNotFound", "BadAmount", "JobNotFound"]) {
      assert.equal(isTerminalReleaseError(new Error(`HostError: ${e}`)), true, e);
    }
    for (const e of ["tx timeout", "ECONNREFUSED", "sequence mismatch"]) {
      assert.equal(isTerminalReleaseError(new Error(e)), false, e);
    }
  });
});
