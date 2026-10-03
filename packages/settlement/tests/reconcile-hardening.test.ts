// S52 — hardening del reconciler (spec 005):
// 1. Guard anti-solape: dos run() concurrentes → uno se skipea, jamás dos
//    scans/release a la vez (un release duplicado es plata y ruido).
// 2. Cursor durable: tras un run exitoso sin intents pendientes, el próximo
//    scan arranca en cursor-REORG_OVERLAP (no desde génesis ni lookback
//    completo). Un cursor que no avanza con intents sin resolver evita el
//    peor bug: descartar como "stale" un intent cuyo Funded quedó detrás
//    del cursor — eso convertiría plata recuperable en huérfano permanente.
// 3. Si el run falla, el cursor NO se guarda → la próxima ventana re-escanea.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createEvmReconciler, InMemoryScanCursor, REORG_OVERLAP_BLOCKS, type FundedJob } from "../src/evm.ts";
import { InMemoryIntentJournal } from "../src/journal.ts";
import type { Address, Hex } from "viem";

const ESCROW = "0x51acE4858652D942dC7b320870e4CDbc5c989cD6" as Address;
const WORKER = "0x784E0a01c683df116fA5bb5A91180d6Fc06BF5CB" as Address;

function fakeChain() {
  const jobs = new Map<number, { state: number; worker: Address }>();
  const submitter = {
    invoke: async (_c: Address, _a: readonly unknown[], fn: string, args: unknown[]) => {
      if (fn === "release") {
        jobs.get(Number(args[0]))!.state = 1;
        return { txHash: "0xrel" as Hex };
      }
      return { txHash: "0x0" as Hex };
    },
  };
  return { jobs, submitter };
}

// Scanner que registra las ventanas pedidas y devuelve los Funded del rango.
function scanner(funded: { jobId: number; worker: Address; block: bigint; txHash: string }[]) {
  const windows: { from: bigint; to: bigint }[] = [];
  const fetchFundedRange = async (from: bigint, to: bigint, worker?: Address): Promise<FundedJob[]> => {
    windows.push({ from, to });
    return funded
      .filter((f) => f.block >= from && f.block <= to && (!worker || f.worker === worker))
      .map((f) => ({ jobId: f.jobId, worker: f.worker, txHash: f.txHash }));
  };
  return { windows, fetchFundedRange };
}

test("guard anti-solape: run() concurrente → skipped, un solo scan", async () => {
  const { jobs, submitter } = fakeChain();
  const { windows, fetchFundedRange } = scanner([]);
  const journal = new InMemoryIntentJournal();
  let headResolve!: (v: bigint) => void;
  const gate = new Promise<bigint>((r) => (headResolve = r));
  let headCalls = 0;
  const r = createEvmReconciler({
    submitter,
    journal,
    escrow: ESCROW,
    headBlock: () => (headCalls++, gate),
    fetchFundedRange,
    readJob: async (id) => jobs.get(id) ?? null,
  });
  const p1 = r.run();
  const p2 = r.run(); // llega mientras headBlock aún espera
  headResolve(1000n);
  const [r1, r2] = await Promise.all([p1, p2]);
  const skipped = [r1, r2].filter((x) => x.skipped).length;
  assert.equal(skipped, 1, "exactamente un run se skipea");
  assert.equal(headCalls, 1, "un solo scan lanzó headBlock");
  void windows;
});

test("cursor: primer run desde floor/lookback; tras éxito escanea desde cursor-overlap", async () => {
  const { jobs, submitter } = fakeChain();
  const { windows, fetchFundedRange } = scanner([]);
  const journal = new InMemoryIntentJournal();
  const cursor = new InMemoryScanCursor();
  let head = 5000n;
  const r = createEvmReconciler({
    submitter,
    journal,
    escrow: ESCROW,
    headBlock: async () => head,
    fetchFundedRange,
    readJob: async (id) => jobs.get(id) ?? null,
    cursor,
    lookback: 1000n,
  });
  await r.run();
  assert.equal(windows[0].to, 5000n);
  assert.equal(windows[0].from, 4000n, "sin cursor: lookback desde head");
  assert.equal(await cursor.load(), 5000n, "cursor guardado tras run limpio");

  head = 5200n;
  await r.run();
  const w2 = windows[windows.length - 1];
  assert.equal(w2.from, 5000n - REORG_OVERLAP_BLOCKS, "segundo run: overlap de reorg, no lookback completo");
  assert.equal(w2.to, 5200n);
  assert.equal(await cursor.load(), 5200n);
});

test("cursor NO avanza mientras queden intents sin resolver", async () => {
  const { jobs, submitter } = fakeChain();
  jobs.set(9, { state: 0, worker: WORKER }); // Funded on-chain en bloque 4500
  const funded = [{ jobId: 9, worker: WORKER, block: 4500n, txHash: "0xf9" }];
  const { windows, fetchFundedRange } = scanner(funded);
  const journal = new InMemoryIntentJournal();
  await journal.recordIntent({
    jobKey: "0xk1",
    worker: WORKER,
    resultHash: "aa",
    forgeSig: "bb",
    createdAt: Date.now(),
  });
  const cursor = new InMemoryScanCursor();
  await cursor.save(4400n); // crash dejó el cursor atrás del Funded
  let head = 4600n;
  // release falla transitorio la primera vez
  let failRelease = true;
  const flaky = {
    invoke: async (c: Address, a: readonly unknown[], fn: string, args: unknown[]) => {
      if (fn === "release" && failRelease) throw new Error("RPC timeout");
      return submitter.invoke(c, a, fn, args);
    },
  };
  const r = createEvmReconciler({
    submitter: flaky,
    journal,
    escrow: ESCROW,
    headBlock: async () => head,
    fetchFundedRange,
    readJob: async (id) => jobs.get(id) ?? null,
    cursor,
  });
  const r1 = await r.run();
  assert.equal(r1.recovered, 0, "release transitorio no recupera");
  assert.equal(await cursor.load(), 4400n, "cursor CONGELADO con intent pendiente — el Funded sigue en ventana");

  failRelease = false;
  head = 4700n;
  const r2 = await r.run();
  assert.equal(r2.recovered, 1, "el reintento encuentra el Funded y libera");
  assert.equal(jobs.get(9)!.state, 1);
  assert.equal(await cursor.load(), 4700n, "cursor avanza una vez resuelto");
  void windows;
});

test("cursor NO se guarda si el run revienta", async () => {
  const { submitter } = fakeChain();
  const cursor = new InMemoryScanCursor();
  const journal = new InMemoryIntentJournal();
  const r = createEvmReconciler({
    submitter,
    journal,
    escrow: ESCROW,
    headBlock: async () => 8000n,
    fetchFundedRange: async () => {
      throw new Error("eth_getLogs 500");
    },
    readJob: async () => null,
    cursor,
  });
  await assert.rejects(() => r.run());
  assert.equal(await cursor.load(), null, "fallo → cursor intacto → re-scan");
});

test("runs repetidos son idempotentes: knownJobIds evita re-release", async () => {
  const { jobs, submitter } = fakeChain();
  jobs.set(3, { state: 0, worker: WORKER });
  let releases = 0;
  const counting = {
    invoke: async (c: Address, a: readonly unknown[], fn: string, args: unknown[]) => {
      if (fn === "release") releases++;
      return submitter.invoke(c, a, fn, args);
    },
  };
  const { fetchFundedRange } = scanner([{ jobId: 3, worker: WORKER, block: 100n, txHash: "0xf3" }]);
  const journal = new InMemoryIntentJournal();
  await journal.recordIntent({ jobKey: "0xk", worker: WORKER, resultHash: "h", forgeSig: "s", createdAt: 1 });
  const cursor = new InMemoryScanCursor();
  let head = 200n;
  const r = createEvmReconciler({
    submitter: counting,
    journal,
    escrow: ESCROW,
    headBlock: async () => head,
    fetchFundedRange,
    readJob: async (id) => jobs.get(id) ?? null,
    cursor,
  });
  const r1 = await r.run();
  assert.equal(r1.recovered, 1);
  head = 300n;
  const r2 = await r.run();
  assert.equal(r2.recovered, 0, "el job ya conocido no se re-libera");
  assert.equal(releases, 1, "exactamente un release on-chain");
});
