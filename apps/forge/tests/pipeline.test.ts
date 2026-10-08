// S47 — PipelineExec (Petals Algo 1-3): happy path, heal con replay,
// sin reemplazo → fail honesto, cancel mid-job.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PipelineExec, simFront } from "../src/pipeline.ts";
import type { StageTransport } from "../src/stagetransport.ts";

// Transport fake: graba opens/steps/closes; `failAtStep` mata el step N-ésimo.
function fakeTransport(opts: { failAtStep?: number; tag?: string } = {}) {
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
    close(sessionId) {
      calls.push({ type: "close", sessionId });
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
});
