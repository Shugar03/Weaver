// S50: reconciler de escrows huérfanos — intent-first + match por eventos.
// Simula el crash window fund→attach y verifica que la plata se recupera.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EvmEscrowSettlement, reconcileEvmOrphans, type FundedJob } from "../src/evm.ts";
import { InMemoryIntentJournal } from "../src/journal.ts";
import type { Address, Hex } from "viem";

const ESCROW = "0x51acE4858652D942dC7b320870e4CDbc5c989cD6" as Address;
const WORKER = "0x784E0a01c683df116fA5bb5A91180d6Fc06BF5CB" as Address;
const hash = Buffer.alloc(32, 7);
const sig = Buffer.alloc(65, 9);

// Fake chain: fundJob asigna jobIds, getJob devuelve estado, release marca.
function fakeChain(opts: { fundFails?: boolean; releaseFails?: boolean } = {}) {
  const calls: string[] = [];
  const jobs = new Map<number, { state: number; worker: Address }>();
  let nextId = 1;
  const submitter = {
    invoke: async (_c: Address, _abi: readonly unknown[], fn: string, args: unknown[]) => {
      calls.push(fn);
      if (fn === "fundJob") {
        if (opts.fundFails) throw new Error("RPC: insufficient funds");
        const jobId = nextId++;
        jobs.set(jobId, { state: 0, worker: args[1] as Address });
        return { txHash: `0xfund${jobId}` as Hex, retval: BigInt(jobId) };
      }
      if (fn === "release") {
        if (opts.releaseFails) throw new Error("RPC timeout");
        const job = jobs.get(Number(args[0]));
        if (job) job.state = 1;
        return { txHash: "0xrel" as Hex };
      }
      return { txHash: "0x0" as Hex };
    },
    ensureAllowance: async () => null,
  };
  const funded = (): FundedJob[] =>
    [...jobs.entries()].map(([jobId, j]) => ({ jobId, worker: j.worker, txHash: `0xfund${jobId}` as Hex }));
  const readJob = async (jobId: number) => jobs.get(jobId) ?? null;
  return { calls, jobs, submitter, funded, readJob };
}

test("settleJob: intent se persiste ANTES de fundJob (orden verificado)", async () => {
  const journal = new InMemoryIntentJournal();
  const chain = fakeChain();
  const order: string[] = [];
  const orig = journal.recordIntent.bind(journal);
  journal.recordIntent = async (i) => {
    order.push("intent");
    return orig(i);
  };
  const s = new EvmEscrowSettlement(chain.submitter, { escrow: ESCROW, token: "0x0" as Address, payout: 10000 }, journal);
  const origInvoke = chain.submitter.invoke;
  chain.submitter.invoke = async (c, a, fn, args) => {
    if (fn === "fundJob") order.push("fund");
    return origInvoke(c, a, fn, args);
  };
  const r = await s.settleJob(hash, sig, WORKER);
  assert.deepEqual(order, ["intent", "fund"], "el proof se persiste antes de fondear");
  assert.equal(r.jobId, 1);
  assert.deepEqual(await journal.intentsWithoutJob(), []);
  assert.deepEqual(await journal.pending(), []);
});

test("journal caído → settleJob aborta ANTES de fondear (fail-closed)", async () => {
  const journal = new InMemoryIntentJournal();
  journal.recordIntent = async () => {
    throw new Error("pg down");
  };
  const chain = fakeChain();
  const s = new EvmEscrowSettlement(chain.submitter, { escrow: ESCROW, token: "0x0" as Address, payout: 10000 }, journal);
  await assert.rejects(() => s.settleJob(hash, sig, WORKER), /pg down/);
  assert.equal(chain.jobs.size, 0, "jamás se fondea lo que no se journalizó");
});

test("crash post-fund: intent sin jobId + Funded on-chain → reconcile libera", async () => {
  // Simula el crash: fundJob minó pero attachJob nunca escribió (journal
  // attachJob no-op = proceso muerto en la ventana). El intent del propio
  // settleJob queda sin jobId; on-chain queda un Funded del mismo worker.
  const journal = new InMemoryIntentJournal();
  const chain = fakeChain();
  journal.attachJob = async () => {}; // "crash" en la ventana fund→attach
  const s = new EvmEscrowSettlement(chain.submitter, { escrow: ESCROW, token: "0x0" as Address, payout: 10000 }, journal);
  await s.settleJob(hash, sig, WORKER); // el fake también libera…

  // …pero en el crash real release nunca corrió: devolvemos el job a Funded
  // para ejercitar el reconciler con el intent huérfano real del settleJob.
  chain.jobs.get(1)!.state = 0;

  const r = await reconcileEvmOrphans({
    submitter: chain.submitter,
    journal,
    escrow: ESCROW,
    fetchFunded: async () => chain.funded(),
    readJob: chain.readJob,
  });
  assert.equal(r.recovered, 1, "el intent + Funded se emparejaron y liberaron");
  assert.equal(chain.jobs.get(1)!.state, 1, "job released on-chain");
  assert.equal(r.orphans, 0);
});

test("intent sin Funded on-chain → descartado, jamás auto-fondea", async () => {
  const journal = new InMemoryIntentJournal();
  await journal.recordIntent({
    jobKey: "0xstale",
    worker: WORKER,
    resultHash: hash.toString("hex"),
    forgeSig: sig.toString("hex"),
    createdAt: Date.now(),
  });
  const chain = fakeChain();
  const r = await reconcileEvmOrphans({
    submitter: chain.submitter,
    journal,
    escrow: ESCROW,
    fetchFunded: async () => [],
    readJob: chain.readJob,
  });
  assert.equal(r.recovered, 0);
  assert.equal(r.staleIntents, 1);
  assert.equal(chain.jobs.size, 0, "nunca fondea un trabajo a destiempo");
  assert.deepEqual(await journal.intentsWithoutJob(), [], "intent descartado — no re-advierte");
});

test("huérfano puro (Funded sin journal) → reportado, no liberado", async () => {
  const journal = new InMemoryIntentJournal();
  const chain = fakeChain();
  // Un job fondeado por "otro proceso" — journal no lo conoce.
  chain.jobs.set(42, { state: 0, worker: WORKER });
  const r = await reconcileEvmOrphans({
    submitter: chain.submitter,
    journal,
    escrow: ESCROW,
    fetchFunded: async () => [{ jobId: 42, worker: WORKER, txHash: "0xfund42" }],
    readJob: chain.readJob,
  });
  assert.equal(r.recovered, 0);
  assert.equal(r.orphans, 1, "huérfano detectado — refund 24h o self-claim");
  assert.equal(chain.jobs.get(42)!.state, 0, "sin proof no se libera");
});

test("job ya Released on-chain no se cuenta como huérfano", async () => {
  const journal = new InMemoryIntentJournal();
  const chain = fakeChain();
  chain.jobs.set(7, { state: 1, worker: WORKER });
  const r = await reconcileEvmOrphans({
    submitter: chain.submitter,
    journal,
    escrow: ESCROW,
    fetchFunded: async () => [{ jobId: 7, worker: WORKER, txHash: "0xf" }],
    readJob: chain.readJob,
  });
  assert.equal(r.orphans, 0);
});

test("jobs conocidos del journal no se re-matchen", async () => {
  const journal = new InMemoryIntentJournal();
  const chain = fakeChain();
  const s = new EvmEscrowSettlement(chain.submitter, { escrow: ESCROW, token: "0x0" as Address, payout: 10000 }, journal);
  await s.settleJob(hash, sig, WORKER); // funded+released, jobId=1 conocido
  // Otro Funded on-chain sin journal → ese sí es huérfano.
  chain.jobs.set(99, { state: 0, worker: WORKER });
  const r = await reconcileEvmOrphans({
    submitter: chain.submitter,
    journal,
    escrow: ESCROW,
    fetchFunded: async () => chain.funded(),
    readJob: chain.readJob,
  });
  assert.equal(r.orphans, 1, "job 1 conocido no se toca; el 99 sí se reporta");
});
