// S17b — cada chat OK liquida solo (fire-and-forget, jamás bloquea el stream).
// Sin settlement en Deps → sample sin settle (dev intacto).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.ts";
import { FakeForgeExec, type ExecRequest, type ForgeExec, type StreamChunk } from "@weaver/forge-exec";
import { FakeVerifier, stellarKeypair, type StagePayout } from "@weaver/settlement";
import { stageSigPreimageV2 } from "@weaver/forge-net";
import { InMemoryTelemetry } from "@weaver/telemetry";
import type { Sample } from "@weaver/telemetry";

const body = JSON.stringify({ model: "qwen3:4b", messages: [{ role: "user", content: "hola" }] });
// S19: chat exige que el modelo exista en la fleet (404 si no).
const forges = () => [
  { forgeId: "fake-forge", model: "qwen3:4b", hot: true, rttMs: 1, queueMs: 0, loadTimeMs: 0, price: 0, reliability: 1 },
];

async function chatOk(
  app: { request: (input: string, init?: RequestInit) => Promise<Response> | Response },
  headers: Record<string, string> = {},
) {
  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
  await res.text();
}

async function executions(app: { request: (input: string, init?: RequestInit) => Promise<Response> | Response }): Promise<Sample[]> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const list = (await (await app.request("/v1/executions")).json()) as Sample[];
    if (list.length > 0 || Date.now() > deadline) return list;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("S17b settle-on-ok", () => {
  it("chat ok + settlement → sample con receipt settled", async () => {
    const telemetry = new InMemoryTelemetry();
    const settlement = {
      async settleJob() {
        return { jobId: 9, fundTx: "fund-9", releaseTx: "rel-9" };
      },
    };
    const app = createApp({ forges, exec: new FakeForgeExec(), telemetry, settlement });
    await chatOk(app);
    const list = await executions(app);
    assert.equal(list.length, 1);
    assert.deepEqual(list[0].settle, { fundTx: "fund-9", releaseTx: "rel-9", status: "settled" });
  });

  it("settlement roto → sample con failed, el chat igual fue 200", async () => {
    const telemetry = new InMemoryTelemetry();
    const settlement = {
      async settleJob(): Promise<{ jobId: number; fundTx: string; releaseTx: string }> {
        throw new Error("rpc caído");
      },
    };
    const app = createApp({ forges, exec: new FakeForgeExec(), telemetry, settlement });
    await chatOk(app);
    const list = await executions(app);
    assert.deepEqual(list[0].settle, { status: "failed" });
  });

  it("sin settlement → sample sin settle", async () => {
    const telemetry = new InMemoryTelemetry();
    const app = createApp({ forges, exec: new FakeForgeExec(), telemetry });
    await chatOk(app);
    const list = await executions(app);
    assert.equal(list.length, 1);
    assert.equal(list[0].settle, undefined);
  });

  it("S23: exec que no emite proof → settle failed, jamás invoca settleJob", async () => {
    const telemetry = new InMemoryTelemetry();
    let calls = 0;
    const settlement = {
      async settleJob() {
        calls++;
        return { jobId: 1, fundTx: "f", releaseTx: "r" };
      },
    };
    // Un forge que sirve tokens pero no firma: el contrato no verificaría.
    class UnprovenExec {
      readonly forgeId = "fake-forge";
      readonly model = "qwen3:4b";
      async *execute() {
        yield { token: "ok", done: false };
        yield { token: "", done: true };
      }
    }
    const app = createApp({ forges, exec: new UnprovenExec(), telemetry, settlement });
    await chatOk(app);
    const list = await executions(app);
    assert.equal(calls, 0);
    assert.deepEqual(list[0].settle, { status: "failed" });
  });
});

describe("S21 Idempotency-Key", () => {
  it("I2: mismo key + proofs DISTINTOS → paga ambos (cada ejecución es trabajo real)", async () => {
    // Bug anterior: dedup por idemKey a secas — un cliente reusando la key
    // suprimía el pago del segundo forge aunque el trabajo fue distinto.
    const telemetry = new InMemoryTelemetry();
    let calls = 0;
    const settlement = {
      async settleJob() {
        calls++;
        return { jobId: calls, fundTx: `f${calls}`, releaseTx: `r${calls}` };
      },
    };
    let n = 0;
    // exec cuyo proof varía por ejecución — output distinto = trabajo distinto
    class ProofExec {
      readonly forgeId = "fake-forge";
      readonly model = "qwen3:4b";
      async *execute(req: { onProof?: (p: { forgeId: string; resultHash: Buffer; signature: Buffer }) => void }) {
        const i = n++;
        yield { token: `out-${i}`, done: false };
        const resultHash = Buffer.alloc(32, 0);
        resultHash[0] = i + 1;
        req.onProof?.({ forgeId: "fake-forge", resultHash, signature: Buffer.alloc(64, 2) });
        yield { token: "", done: true };
      }
    }
    const app = createApp({ forges, exec: new ProofExec(), telemetry, settlement });
    await chatOk(app, { "idempotency-key": "misma-key" });
    await chatOk(app, { "idempotency-key": "misma-key" });
    await executions(app);
    assert.equal(calls, 2); // dos outputs distintos = dos trabajos = dos pagos
  });

  it("mismo key en 2 chats → re-ejecuta pero un solo settle on-chain", async () => {
    const telemetry = new InMemoryTelemetry();
    let calls = 0;
    const settlement = {
      async settleJob() {
        calls++;
        return { jobId: calls, fundTx: `f${calls}`, releaseTx: `r${calls}` };
      },
    };
    const app = createApp({ forges, exec: new FakeForgeExec(), telemetry, settlement });
    const key = { "idempotency-key": "k-1" };
    await chatOk(app, key);
    await chatOk(app, key);
    const list = await executions(app);
    assert.equal(list.length, 2); // el retry sirvió de verdad
    assert.equal(calls, 1); // pero el cobro no se duplicó
  });

  it("keys distintas → dos settles; sin key → cada chat settlea", async () => {
    const telemetry = new InMemoryTelemetry();
    let calls = 0;
    const settlement = {
      async settleJob() {
        calls++;
        return { jobId: calls, fundTx: "f", releaseTx: "r" };
      },
    };
    const app = createApp({ forges, exec: new FakeForgeExec(), telemetry, settlement });
    await chatOk(app, { "idempotency-key": "a" });
    await chatOk(app, { "idempotency-key": "b" });
    await chatOk(app);
    await executions(app);
    assert.equal(calls, 3);
  });
});

describe("S23 x402 settle post-serve", () => {
  it("chat pagado → sample con payerTx del settle del cliente", async () => {
    const telemetry = new InMemoryTelemetry();
    const app = createApp({
      forges,
      exec: new FakeForgeExec(),
      telemetry,
      paywall: { verifier: new FakeVerifier(), payTo: "GOPERATOR" },
    });
    await chatOk(app, { "x-payment": "valid-proof" });
    const list = await executions(app);
    assert.equal(list.length, 1);
    assert.equal(list[0].settle?.payerTx, "fake-client-tx");
    assert.equal(list[0].settle?.status, "settled");
  });

  it("chat pagado + escrow → las dos patas: payerTx y fundTx/releaseTx", async () => {
    const telemetry = new InMemoryTelemetry();
    const settlement = {
      async settleJob() {
        return { jobId: 3, fundTx: "fund-x", releaseTx: "rel-x" };
      },
    };
    const app = createApp({
      forges,
      exec: new FakeForgeExec(),
      telemetry,
      settlement,
      paywall: { verifier: new FakeVerifier(), payTo: "GOPERATOR" },
    });
    await chatOk(app, { "x-payment": "valid-proof" });
    const list = await executions(app);
    assert.deepEqual(list[0].settle, {
      payerTx: "fake-client-tx",
      fundTx: "fund-x",
      releaseTx: "rel-x",
      status: "settled",
    });
  });
});

// B6 — payout split por stage: el gateway convierte las stageSigs verificadas
// (con forgePubkey resuelta por verifyStageSigs) en StagePayout[] — cada stage
// cobra su escrow probando con SU firma sobre el preimage v2. El receipt
// declara el reparto en bps; sin settleJobSplit cae al single-settle.
describe("B6 payout split", () => {
  const kpS1 = stellarKeypair();
  const kpS2 = stellarKeypair();
  const kpCoord = stellarKeypair();
  const inChain = "aa".repeat(32);
  const outChain = "bb".repeat(32);

  // Exec fake federado: emite proof con stageSigs ya verificadas (así las
  // deja remote.ts post-verifyStageSigs — forgePubkey resuelta).
  const federatedExec = (sigs: unknown[]): ForgeExec => ({
    forgeId: "fake-forge",
    model: "qwen3:4b",
    async *execute(req: ExecRequest): AsyncIterable<StreamChunk> {
      yield { token: "ok", done: false };
      req.onProof?.({
        forgeId: "fake-forge",
        resultHash: Buffer.alloc(32, 1),
        signature: Buffer.alloc(64, 2),
        stageSigs: sigs as never,
      });
      yield { token: "", done: true, stats: { genTokens: 2 } };
    },
  });

  const verifiedSigs = () => [
    {
      endpoint: "tcp://a", blocks: [0, 40] as [number, number], sessionId: "j:s0",
      inChain, outChain, sig: "11".repeat(64), forgePubkey: kpS1.pubkey,
    },
    {
      endpoint: "tcp://b", blocks: [40, 80] as [number, number], sessionId: "j:s1",
      inChain: outChain, outChain: "cc".repeat(32), sig: "22".repeat(64), forgePubkey: kpS2.pubkey,
    },
  ];

  it("stageSigs verificadas → settleJobSplit con proofHash recomputado + payoutSplit en receipt", async () => {
    const telemetry = new InMemoryTelemetry();
    const captured: { stages?: StagePayout[]; worker?: string } = {};
    const settlement = {
      async settleJob() {
        return { jobId: 1, fundTx: "f", releaseTx: "r" };
      },
      async settleJobSplit(_h: Buffer, _s: Buffer, worker: string | undefined, _stats: unknown, stages: StagePayout[]) {
        captured.stages = stages;
        captured.worker = worker;
        return { jobId: 9, fundTx: "f9", releaseTx: "r9", splits: [] };
      },
    };
    const app = createApp({
      forges,
      exec: federatedExec(verifiedSigs()),
      telemetry,
      settlement: settlement as never,
      forgePubkeyOf: () => kpCoord.pubkey,
    });
    const res = await app.request("/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" }, body,
    });
    const json = (await res.json()) as { id: string; weaver_proof?: { payoutSplit?: { coordBps: number; stages: { worker?: string; bps: number }[] } } };
    // Receipt declara el reparto: 80% del pool a los 2 stages iguales.
    assert.equal(json.weaver_proof?.payoutSplit?.coordBps, 2000);
    assert.deepEqual(
      json.weaver_proof?.payoutSplit?.stages.map((s) => s.bps),
      [4000, 4000],
    );
    assert.deepEqual(
      json.weaver_proof?.payoutSplit?.stages.map((s) => s.worker),
      [kpS1.pubkey, kpS2.pubkey],
    );
    // Settle fire-and-forget — poll hasta que el fake lo capturó.
    const deadline = Date.now() + 3000;
    while (!captured.stages && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    assert.equal(captured.worker, kpCoord.pubkey);
    assert.equal(captured.stages?.length, 2);
    // La prueba de cobro del stage = su preimage v2 firmado — 32 bytes.
    assert.deepEqual(
      captured.stages?.[0].proofHash,
      stageSigPreimageV2(json.id, "j:s0", inChain, outChain),
    );
    assert.equal(captured.stages?.[0].worker, kpS1.pubkey);
    assert.equal(captured.stages?.[0].sig.toString("hex"), "11".repeat(64));
    assert.deepEqual(captured.stages?.[1].blocks, [40, 80]);
  });

  it("sin settleJobSplit → cae a settleJob single (coordinator cobra entero)", async () => {
    const telemetry = new InMemoryTelemetry();
    let singleCalls = 0;
    const settlement = {
      async settleJob() {
        singleCalls++;
        return { jobId: 1, fundTx: "f", releaseTx: "r" };
      },
    };
    const app = createApp({
      forges,
      exec: federatedExec(verifiedSigs()),
      telemetry,
      settlement: settlement as never,
      forgePubkeyOf: () => kpCoord.pubkey,
    });
    await app.request("/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" }, body,
    });
    const deadline = Date.now() + 3000;
    while (!singleCalls && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    assert.equal(singleCalls, 1);
  });

  it("stageSig sin forgePubkey → excluida del split, el resto cobra", async () => {
    const telemetry = new InMemoryTelemetry();
    const captured: { stages?: StagePayout[] } = {};
    const settlement = {
      async settleJob() {
        return { jobId: 1, fundTx: "f", releaseTx: "r" };
      },
      async settleJobSplit(_h: Buffer, _s: Buffer, _w: unknown, _st: unknown, stages: StagePayout[]) {
        captured.stages = stages;
        return { jobId: 9, fundTx: "f9", releaseTx: "r9", splits: [] };
      },
    };
    const sigs = verifiedSigs();
    delete (sigs[1] as { forgePubkey?: string }).forgePubkey; // no verificada
    const app = createApp({
      forges,
      exec: federatedExec(sigs),
      telemetry,
      settlement: settlement as never,
      forgePubkeyOf: () => kpCoord.pubkey,
    });
    await app.request("/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" }, body,
    });
    const deadline = Date.now() + 3000;
    while (!captured.stages && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    assert.equal(captured.stages?.length, 1); // solo el verificado cobra
    assert.equal(captured.stages?.[0].worker, kpS1.pubkey);
  });
});
