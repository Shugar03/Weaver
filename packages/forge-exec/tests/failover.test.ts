// S3 — FailoverForgeExec: failover en dispatch (<500ms), error explícito mid-stream.
// Contrato: primario muerto ANTES del primer token → se prueba el siguiente.
// Muerto DESPUÉS → se propaga (reintentar duplicaría tokens ya enviados).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FailoverForgeExec } from "../src/failover.ts";
import type { ExecRequest, ForgeExec, StreamChunk } from "../src/ports.ts";

class DeadExec implements ForgeExec {
  readonly forgeId = "dead";
  readonly model = "qwen3.5:4b";
  async *execute(_req: ExecRequest): AsyncIterable<StreamChunk> {
    throw new Error("forge caído");
  }
}

class FlakyExec implements ForgeExec {
  readonly forgeId = "flaky";
  readonly model = "qwen3.5:4b";
  async *execute(_req: ExecRequest): AsyncIterable<StreamChunk> {
    yield { token: "parcial", done: false };
    throw new Error("murió a mitad");
  }
}

class OkExec implements ForgeExec {
  readonly forgeId = "ok";
  readonly model = "qwen3.5:4b";
  async *execute(_req: ExecRequest): AsyncIterable<StreamChunk> {
    yield { token: "ok-secondary", done: false };
    yield { token: "", done: true };
  }
}

async function collect(exec: ForgeExec): Promise<string> {
  let out = "";
  for await (const c of exec.execute({ jobId: "j", model: "qwen3.5:4b", prompt: "hola" })) out += c.token;
  return out;
}

describe("S3 failover dispatch", () => {
  it("primario muerto → secondary completa y reroute <500ms", async () => {
    const f = new FailoverForgeExec([new DeadExec(), new OkExec()]);
    const text = await collect(f);
    assert.ok(text.includes("ok-secondary"));
    assert.ok(f.lastFailoverMs < 500, `failover tardó ${f.lastFailoverMs}ms`);
  });

  it("todos muertos → throw, no silencio", async () => {
    const f = new FailoverForgeExec([new DeadExec()]);
    await assert.rejects(collect(f), /caído/);
  });
});

describe("S3 mid-stream explícito", () => {
  it("muerte a mitad → propaga error, no trunca en silencio", async () => {
    const f = new FailoverForgeExec([new FlakyExec(), new OkExec()]);
    await assert.rejects(collect(f), /mitad/);
  });
});

describe("S19 onForge", () => {
  it("requests concurrentes se atribuyen cada una su forge (sin cross-talk)", async () => {
    // pares caen en "primero" → sirve "segundo"; impares sirven en "primero".
    class AlternatingExec implements ForgeExec {
      readonly forgeId = "primero";
      readonly model = "m";
      async *execute(req: ExecRequest): AsyncIterable<StreamChunk> {
        if (req.jobId.endsWith("2")) throw new Error("cae solo pares");
        yield { token: "p1", done: false };
        yield { token: "", done: true };
      }
    }
    class SecondExec implements ForgeExec {
      readonly forgeId = "segundo";
      readonly model = "m";
      async *execute(): AsyncIterable<StreamChunk> {
        yield { token: "s1", done: false };
        yield { token: "", done: true };
      }
    }
    const seen: Record<string, string[]> = { j1: [], j2: [] };
    const f = new FailoverForgeExec([new AlternatingExec(), new SecondExec()]);
    const run = (req: ExecRequest) => {
      return (async () => {
        for await (const _ of f.execute(req)) void _;
      })();
    };
    await Promise.all([
      run({ jobId: "j1", model: "m", prompt: "x", onForge: (id) => seen.j1.push(id) }),
      run({ jobId: "j2", model: "m", prompt: "x", onForge: (id) => seen.j2.push(id) }),
    ]);
    assert.deepEqual(seen.j1, ["primero"]);
    assert.deepEqual(seen.j2, ["segundo"]);
  });

  it("reporta una sola vez el forge que sirvió de verdad (por request, no compartido)", async () => {
    const seen: string[] = [];
    const f = new FailoverForgeExec([new DeadExec(), new OkExec()]);
    let out = "";
    for await (const c of f.execute({
      jobId: "j",
      model: "qwen3.5:4b",
      prompt: "h",
      onForge: (id) => seen.push(id),
    })) {
      out += c.token;
    }
    assert.equal(out, "ok-secondary");
    assert.deepEqual(seen, ["ok"]);
  });

  it("sin onForge en el request, no explota", async () => {
    const f = new FailoverForgeExec([new OkExec()]);
    assert.equal(await collect(f), "ok-secondary");
  });
});

describe("S27 onFail — el breaker ve cada intento fallido", () => {
  it("fallo pre-token → onFail(forge) y salta al siguiente", async () => {
    const failed: string[] = [];
    const served: string[] = [];
    const f = new FailoverForgeExec([new DeadExec(), new OkExec()]);
    let out = "";
    for await (const c of f.execute({
      jobId: "j",
      model: "m",
      prompt: "h",
      onFail: (id) => failed.push(id),
      onForge: (id) => served.push(id),
    })) {
      out += c.token;
    }
    assert.equal(out, "ok-secondary");
    assert.deepEqual(failed, ["dead"]);
    assert.deepEqual(served, ["ok"]);
  });

  it("muerte mid-stream → onFail del forge que moría + error propaga", async () => {
    const failed: string[] = [];
    const f = new FailoverForgeExec([new FlakyExec(), new OkExec()]);
    await assert.rejects(async () => {
      for await (const _ of f.execute({
        jobId: "j",
        model: "m",
        prompt: "h",
        onFail: (id) => failed.push(id),
      })) void _;
    }, /mitad/);
    assert.deepEqual(failed, ["flaky"]);
  });

  it("todos fallan → onFail por cada intento", async () => {
    const failed: string[] = [];
    const f = new FailoverForgeExec([new DeadExec(), new DeadExec()]);
    await assert.rejects(async () => {
      for await (const _ of f.execute({
        jobId: "j",
        model: "m",
        prompt: "h",
        onFail: (id) => failed.push(id),
      })) void _;
    });
    assert.deepEqual(failed, ["dead", "dead"]);
  });
});
