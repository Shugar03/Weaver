// S47 — PipelineExec (Petals Algo 1-3): happy path, heal con replay,
// sin reemplazo → fail honesto, cancel mid-job.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PipelineExec, simFront } from "../src/pipeline.ts";
import type { StageTransport } from "../src/stagetransport.ts";

// Transport fake: graba opens/steps/closes; `failAtStep` mata el step N-ésimo.
// `sig` simula la firma del close-ack (stage real: sign de su chain).
function fakeTransport(opts: { failAtStep?: number; tag?: string; sig?: string } = {}) {
  const calls: { type: string; sessionId: string; seq?: number; payload?: string }[] = [];
  let steps = 0;
  const t: StageTransport & { calls: typeof calls } = {
    calls,
    get alive() {
      return true;
    },
    async open(s) {
      calls.push({ type: "open", sessionId: s.sessionId });
    },
    async step(s) {
      steps++;
      calls.push({ type: "step", sessionId: s.sessionId, seq: s.seq, payload: s.payload });
      if (opts.failAtStep !== undefined && steps === opts.failAtStep) {
        throw new Error("stage muerto (fake)");
      }
      // stage-sim: marca la activación — el front la limpia al final.
      return { payload: Buffer.from(`${Buffer.from(s.payload, "base64").toString("utf8")}:${opts.tag ?? "s0"}`).toString("base64") };
    },
    inject(s) {
      calls.push({ type: "inject", sessionId: s.sessionId, seq: s.seq, payload: s.payload });
    },
    async expectOut() {
      throw new Error("fake: expectOut no implementado");
    },
    async replay() {},
    injectFwd() {},
    async repoint() {},
    async close(sessionId) {
      calls.push({ type: "close", sessionId });
      return opts.sig ? { sig: opts.sig } : {};
    },
    dispose() {
      calls.push({ type: "dispose", sessionId: "" });
    },
  };
  return t;
}

const STAGES = [
  { endpoint: "10.0.0.1:9001", blocks: [0, 16] as [number, number] },
  { endpoint: "10.0.0.2:9001", blocks: [16, 32] as [number, number] },
];

const collect = async (exec: PipelineExec, jobId: string, prompt: string, signal?: AbortSignal) => {
  const out: string[] = [];
  for await (const c of exec.execute({ jobId, model: "sim-32", prompt, ...(signal ? { signal } : {}) })) {
    if (!c.done) out.push(c.token);
  }
  return out.join("");
};

describe("S47 PipelineExec", () => {
  it("happy path — relay por 2 stages, sesiones cerradas al final", async () => {
    const t1 = fakeTransport({ tag: "s0" });
    const t2 = fakeTransport({ tag: "s1" });
    const exec = new PipelineExec({
      forgeId: "c1",
      model: "sim-32",
      stages: STAGES,
      dial: (e) => (e === STAGES[0].endpoint ? t1 : t2),
      front: simFront(),
    });
    assert.equal(await collect(exec, "j1", "a b c"), "a b c ");
    assert.equal(t1.calls.filter((c) => c.type === "open").length, 1);
    assert.equal(t1.calls.filter((c) => c.type === "close").length, 1);
    assert.ok(t2.calls.filter((c) => c.type === "step").length >= 3);
    // seq monotónico desde 0.
    assert.deepEqual(t1.calls.filter((c) => c.type === "step").map((c) => c.seq), [0, 1, 2, 3]);
  });

  it("stage muere mid-job → stage.need → replay → el job continúa", async () => {
    const dead = fakeTransport({ tag: "s0", failAtStep: 3 }); // muere en el 3er step
    const spare = fakeTransport({ tag: "s9" });
    const t2 = fakeTransport({ tag: "s1" });
    const needs: { dead: string; blocks: [number, number] }[] = [];
    const exec = new PipelineExec({
      forgeId: "c1",
      model: "sim-32",
      stages: STAGES,
      dial: (e) => (e === "10.0.0.9:9001" ? spare : e === STAGES[0].endpoint ? dead : t2),
      front: simFront(),
      requestStage: async (d, blocks) => {
        needs.push({ dead: d, blocks });
        return { endpoint: "10.0.0.9:9001", blocks };
      },
    });
    assert.equal(await collect(exec, "j2", "a b c d"), "a b c d ");
    assert.deepEqual(needs, [{ dead: "10.0.0.1:9001", blocks: [0, 16] }]);
    // REPLAY: el spare recibió la historia completa (seqs 0..n-1) antes del
    // step actual — dual attention cache del paper.
    const spareSteps = spare.calls.filter((c) => c.type === "step").map((c) => c.seq!);
    assert.deepEqual(spareSteps.slice(0, 2), [0, 1]);
    assert.ok(spareSteps.length >= 3);
    assert.ok(dead.calls.some((c) => c.type === "dispose"));
  });

  it("stage muere sin reemplazo → fail honesto (offer vacío)", async () => {
    const dead = fakeTransport({ failAtStep: 1 });
    const t2 = fakeTransport({ tag: "s1" });
    const exec = new PipelineExec({
      forgeId: "c1",
      model: "sim-32",
      stages: STAGES,
      dial: (e) => (e === STAGES[0].endpoint ? dead : t2),
      front: simFront(),
      requestStage: async () => ({}),
    });
    await assert.rejects(() => collect(exec, "j3", "a b"), /sin reemplazo/);
    assert.ok(t2.calls.some((c) => c.type === "close"));
  });

  it("sin requestStage cableado → muere honesto (sin heal)", async () => {
    const dead = fakeTransport({ failAtStep: 1 });
    const exec = new PipelineExec({
      forgeId: "c1",
      model: "sim-32",
      stages: STAGES,
      dial: () => dead,
      front: simFront(),
    });
    await assert.rejects(() => collect(exec, "j4", "a b"), /stage muerto/);
  });

  it("abort mid-job → sesiones cerradas, error propagado", async () => {
    const t1 = fakeTransport({ tag: "s0" });
    const t2 = fakeTransport({ tag: "s1" });
    const ac = new AbortController();
    const exec = new PipelineExec({
      forgeId: "c1",
      model: "sim-32",
      stages: STAGES,
      dial: (e) => (e === STAGES[0].endpoint ? t1 : t2),
      front: simFront(),
    });
    const out: string[] = [];
    await assert.rejects(async () => {
      for await (const c of exec.execute({ jobId: "j5", model: "sim-32", prompt: "a b c d e", signal: ac.signal })) {
        if (c.done) continue;
        out.push(c.token);
        if (out.length === 2) ac.abort();
      }
    }, /cancelado/);
    assert.ok(t1.calls.some((c) => c.type === "close"));
    assert.ok(t2.calls.some((c) => c.type === "close"));
  });

  it("A4: done lleva stageSigs — firma+chain por tramo; el muerto no firma", async () => {
    const sig = "ab".repeat(64);
    const t1 = fakeTransport({ tag: "s0", sig });
    const t2 = fakeTransport({ tag: "s1", sig });
    const exec = new PipelineExec({
      forgeId: "c1",
      model: "sim-32",
      stages: STAGES,
      dial: (e) => (e === STAGES[0].endpoint ? t1 : t2),
      front: simFront(),
    });
    let done: { stageSigs?: { endpoint: string; sessionId: string; chain?: string; sig: string }[] } = {};
    for await (const c of exec.execute({ jobId: "j6", model: "sim-32", prompt: "a b" })) {
      if (c.done) done = c;
    }
    assert.equal(done.stageSigs?.length, 2);
    assert.deepEqual(done.stageSigs!.map((s) => s.endpoint), STAGES.map((s) => s.endpoint));
    assert.ok(done.stageSigs!.every((s) => s.sig === sig && s.chain && s.chain.length === 64 && s.sessionId.startsWith("j6:")));
    // Chains distintos entre stages (cada sesión tiene su historia).
    assert.notEqual(done.stageSigs![0].chain, done.stageSigs![1].chain);
  });

  it("A4: stage reemplazado firma SU sesión (replay incluido), el muerto no", async () => {
    const dead = fakeTransport({ tag: "s0", failAtStep: 3, sig: "dead" });
    const spare = fakeTransport({ tag: "s9", sig: "cd".repeat(64) });
    const t2 = fakeTransport({ tag: "s1", sig: "ef".repeat(64) });
    const exec = new PipelineExec({
      forgeId: "c1",
      model: "sim-32",
      stages: STAGES,
      dial: (e) => (e === "10.0.0.9:9001" ? spare : e === STAGES[0].endpoint ? dead : t2),
      front: simFront(),
      requestStage: async (_d, blocks) => ({ endpoint: "10.0.0.9:9001", blocks }),
    });
    let done: { stageSigs?: { endpoint: string; sessionId: string; sig: string }[] } = {};
    for await (const c of exec.execute({ jobId: "j7", model: "sim-32", prompt: "a b c d" })) {
      if (c.done) done = c;
    }
    // Solo los tramos que sobrevivieron firman — el muerto nunca cerró.
    assert.deepEqual(done.stageSigs!.map((s) => s.endpoint).sort(), ["10.0.0.2:9001", "10.0.0.9:9001"]);
    assert.ok(done.stageSigs!.every((s) => !s.sessionId.includes(":s0") || s.sessionId.includes("r")));
  });
});
