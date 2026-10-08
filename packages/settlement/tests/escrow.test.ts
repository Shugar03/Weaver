// S17b — settlement programático: fund + release por job, operador fondea.
// El submitter es seam: el test inyecta fake, prod inyecta RpcSubmitter (testnet).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { nativeToScVal, scValToNative } from "@stellar/stellar-sdk";
import { EscrowSettlement, isTerminalReleaseError, payoutFor, stellarKeypair, stellarVerify, sweepPendingSettles, type ChainSubmitter, type StagePayout } from "../src/escrow.ts";
import { computeStageSplit, COORD_BPS } from "../src/split.ts";
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

// B6 — computeStageSplit: regla pura del reparto. Solo entran stages cuya
// stageSig ya verificó — la proporción es por bloques cubiertos y el
// remainder de redondeo lo absorbe el coordinator.
describe("B6 computeStageSplit", () => {
  it("stages reparten (10000-coordBps) ∝ bloques; coord absorbe el resto", () => {
    // 2 tramos iguales de 40 bloques sobre total 100000, coordBps=2000.
    const { coord, stageAmounts } = computeStageSplit(100_000, [
      { blocks: [0, 40] },
      { blocks: [40, 80] },
    ]);
    assert.equal(stageAmounts[0], 40_000);
    assert.equal(stageAmounts[1], 40_000);
    assert.equal(coord, 20_000); // base + remainder (0 acá)
  });

  it("pondera por bloques — tramo doble cobra doble", () => {
    const { coord, stageAmounts } = computeStageSplit(90_000, [
      { blocks: [0, 20] },
      { blocks: [20, 60] }, // el doble de ancho
    ]);
    assert.equal(stageAmounts[0], 24_000); // 72000 × 20/60
    assert.equal(stageAmounts[1], 48_000); // 72000 × 40/60
    assert.equal(coord, 18_000);
  });

  it("remainder de redondeo → coordinator (nunca se pierde ni inventa)", () => {
    // 3 stages de 1 bloque sobre total 100 → pool 80 → floor(80/3)=26×3=78.
    const { coord, stageAmounts } = computeStageSplit(100, [
      { blocks: [0, 1] },
      { blocks: [1, 2] },
      { blocks: [2, 3] },
    ]);
    assert.deepEqual(stageAmounts, [26, 26, 26]);
    assert.equal(coord, 22); // 20 (coord share) + 2 (remainder)
  });

  it("sin stages verificados → todo al coordinator", () => {
    assert.deepEqual(computeStageSplit(50_000, []), { coord: 50_000, stageAmounts: [] });
  });

  it("tramo degenerado (blocks invertidos) aporta 0 de peso", () => {
    const { coord, stageAmounts } = computeStageSplit(100_000, [
      { blocks: [10, 10] },
      { blocks: [10, 50] },
    ]);
    assert.equal(stageAmounts[0], 0);
    assert.equal(stageAmounts[1], 80_000);
    assert.equal(coord, 20_000);
  });
});

// B6 — settleJobSplit: un escrow por beneficiario. El stage cobra con SU
// stageSig sobre SU proofHash — release verifica ed25519 contra la pubkey
// que el worker registró on-chain. Escrow aislado: un stage que revierte no
// aborta los demás pagos.
describe("B6 settleJobSplit", () => {
  // Pubkeys válidas (strkey) — Address().toScVal() rechaza las inválidas.
  const S1 = stellarKeypair().pubkey;
  const S2 = stellarKeypair().pubkey;
  const stage1: StagePayout = {
    worker: S1,
    blocks: [0, 40],
    proofHash: Buffer.alloc(32, 11),
    sig: Buffer.alloc(64, 12),
  };
  const stage2: StagePayout = {
    worker: S2,
    blocks: [40, 80],
    proofHash: Buffer.alloc(32, 21),
    sig: Buffer.alloc(64, 22),
  };

  it("fund+release por beneficiario: stage cobra con SU proofHash y SU sig", async () => {
    const calls: { fn: string; args?: xdr.ScVal[] }[] = [];
    let nextJob = 100;
    const sub: ChainSubmitter = {
      async invoke(_c, fn, args) {
        calls.push({ fn, args });
        if (fn === "fund_job") return { txHash: "f", retval: nativeToScVal(nextJob++, { type: "u64" }) };
        return { txHash: "r" };
      },
    };
    const s = new EscrowSettlement(sub, { contractId: CONTRACT, operator: OPERATOR, worker: WORKER, payout: 100_000 });
    const r = await s.settleJobSplit(HASH, SIG, WORKER, undefined, [stage1, stage2]);
    // 3 escrows: coord + 2 stages.
    assert.deepEqual(calls.map((c) => c.fn), ["fund_job", "release", "fund_job", "release", "fund_job", "release"]);
    assert.equal(r.splits.length, 2);
    // Coord escrow: amount = 20% de 100000.
    assert.equal(scValToNative(calls[0].args?.[1] as xdr.ScVal), 20_000n);
    assert.equal(scValToNative(calls[0].args?.[2] as xdr.ScVal), WORKER);
    // Release del coord usa resultHash+forgeSig (prueba normal).
    assert.deepEqual(scValToNative(calls[1].args?.[2] as xdr.ScVal), new Uint8Array(HASH));
    // Stage escrows: worker ligado = pubkey del stage, amount ∝ bloques.
    assert.equal(scValToNative(calls[2].args?.[2] as xdr.ScVal), S1);
    assert.equal(scValToNative(calls[2].args?.[1] as xdr.ScVal), 40_000n);
    assert.equal(scValToNative(calls[4].args?.[2] as xdr.ScVal), S2);
    // Release del stage: result_hash = SU proofHash, sig = SU stageSig.
    assert.deepEqual(scValToNative(calls[3].args?.[2] as xdr.ScVal), new Uint8Array(stage1.proofHash));
    assert.deepEqual(scValToNative(calls[3].args?.[3] as xdr.ScVal), new Uint8Array(stage1.sig));
    assert.deepEqual(scValToNative(calls[5].args?.[2] as xdr.ScVal), new Uint8Array(stage2.proofHash));
  });

  it("un stage sin registrar (fund revierte) no aborta los demás — error declarado", async () => {
    const calls: { fn: string }[] = [];
    let nextJob = 200;
    const sub: ChainSubmitter = {
      async invoke(_c, fn, args) {
        calls.push({ fn });
        if (fn === "fund_job") {
          const worker = scValToNative(args?.[2] as xdr.ScVal) as string;
          if (worker === S1) throw new Error("HostError: ForgeNotFound");
          return { txHash: "f", retval: nativeToScVal(nextJob++, { type: "u64" }) };
        }
        return { txHash: "r" };
      },
    };
    const s = new EscrowSettlement(sub, { contractId: CONTRACT, operator: OPERATOR, worker: WORKER, payout: 100_000 });
    const r = await s.settleJobSplit(HASH, SIG, WORKER, undefined, [stage1, stage2]);
    assert.match(r.splits[0].error ?? "", /ForgeNotFound/);
    assert.equal(r.splits[1].releaseTx, "r"); // el segundo stage cobró igual
    assert.equal(calls.filter((c) => c.fn === "release").length, 2); // coord + s2
  });

  it("stats escalan el total: perToken entra al pool del split", async () => {
    const calls: { fn: string; args?: xdr.ScVal[] }[] = [];
    let nextJob = 300;
    const sub: ChainSubmitter = {
      async invoke(_c, fn, args) {
        calls.push({ fn, args });
        if (fn === "fund_job") return { txHash: "f", retval: nativeToScVal(nextJob++, { type: "u64" }) };
        return { txHash: "r" };
      },
    };
    const s = new EscrowSettlement(sub, {
      contractId: CONTRACT, operator: OPERATOR, worker: WORKER, payout: 100_000, perToken: 1000,
    });
    await s.settleJobSplit(HASH, SIG, WORKER, { genTokens: 100 }, [stage1]);
    // total = 100000 + 100×1000 = 200000 → stage pool 160000.
    assert.equal(scValToNative(calls[2].args?.[1] as xdr.ScVal), 160_000n);
  });

  it("coord share es exacto: total - Σstages, remainder incluido", async () => {
    const calls: { fn: string; args?: xdr.ScVal[] }[] = [];
    let nextJob = 400;
    const sub: ChainSubmitter = {
      async invoke(_c, fn, args) {
        calls.push({ fn, args });
        if (fn === "fund_job") return { txHash: "f", retval: nativeToScVal(nextJob++, { type: "u64" }) };
        return { txHash: "r" };
      },
    };
    const s = new EscrowSettlement(sub, { contractId: CONTRACT, operator: OPERATOR, worker: WORKER, payout: 100 });
    const three: StagePayout[] = [0, 1, 2].map((i) => ({
      worker: S1, blocks: [i, i + 1] as [number, number],
      proofHash: Buffer.alloc(32, 30 + i), sig: Buffer.alloc(64, 40 + i),
    }));
    const r = await s.settleJobSplit(HASH, SIG, WORKER, undefined, three);
    const stageTotal = r.splits.reduce((a, x) => a + (x.amount ?? 0), 0);
    assert.equal(scValToNative(calls[0].args?.[1] as xdr.ScVal), BigInt(100 - stageTotal));
    assert.equal(stageTotal, 78); // floor(80/3)×3 — remainder 2 al coord
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
