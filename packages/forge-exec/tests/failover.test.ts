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

describe("S3 cliente abortado", () => {
  it("signal abortada → no prueba el siguiente forge", async () => {
    // Cliente desconectado = nadie lee el resultado: el retry es cómputo al pedo.
    let okCalls = 0;
    class CountingOk extends OkExec {
      override async *execute(req: ExecRequest): AsyncIterable<StreamChunk> {
        okCalls++;
        yield* super.execute(req);
      }
    }
    const ac = new AbortController();
    ac.abort(); // cliente ya se fue antes del dispatch
    const f = new FailoverForgeExec([new DeadExec(), new CountingOk()]);
    await assert.rejects(async () => {
      for await (const c of f.execute({ jobId: "j", model: "m", prompt: "p", signal: ac.signal })) void c;
    });
    assert.equal(okCalls, 0);
  });
});
