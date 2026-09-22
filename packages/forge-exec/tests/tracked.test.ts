// S27 — TrackedExec: cuenta jobs in-flight por forge. Es la ÚNICA fuente de
// carga real para el scheduler: queueMs = inFlight × expectedMs (serve.ts).
// Regla: el contador vive dentro del generator — arranca al primer next()
// (execute() es lazy) y muere en finally (completa, error o cancelación).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TrackedExec } from "../src/tracked.ts";
import type { ExecRequest, ForgeExec, StreamChunk } from "../src/ports.ts";

const req = (over: Partial<ExecRequest> = {}): ExecRequest => ({
  jobId: "j1",
  model: "qwen3:4b",
  prompt: "hola",
  ...over,
});

// Forge que se queda streameando hasta que el test lo suelta.
// Un gate POR llamada: dos streams concurrentes tienen gates distintos.
class BlockingExec implements ForgeExec {
  readonly forgeId = "blocking";
  readonly model = "qwen3:4b";
  private gates: (() => void)[] = [];
  async *execute(_req: ExecRequest): AsyncIterable<StreamChunk> {
    yield { token: "a", done: false };
    await new Promise<void>((r) => {
      this.gates.push(r);
    });
    yield { token: "b", done: true };
  }
  release() {
    this.gates.forEach((g) => g());
    this.gates = [];
  }
}

class FailExec implements ForgeExec {
  readonly forgeId = "failer";
  readonly model = "qwen3:4b";
  async *execute(_req: ExecRequest): AsyncIterable<StreamChunk> {
    yield { token: "a", done: false };
    throw new Error("murió a mitad");
  }
}

describe("TrackedExec", () => {
  it("cuenta in-flight durante el stream y vuelve a 0 al terminar", async () => {
    const inner = new BlockingExec();
    const tracked = new TrackedExec(inner);
    assert.equal(tracked.inFlight, 0);

    const drain = (async () => {
      for await (const _ of tracked.execute(req())) {
        /* consume */
      }
    })();
    // El generator arrancó: el forge está ocupado aunque aún no terminó.
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(tracked.inFlight, 1);

    inner.release();
    await drain;
    assert.equal(tracked.inFlight, 0);
  });

  it("cuenta N streams concurrentes sobre el mismo forge", async () => {
    const inner = new BlockingExec();
    const tracked = new TrackedExec(inner);
    const drains = [0, 1].map(() =>
      (async () => {
        for await (const _ of tracked.execute(req())) {
          /* consume */
        }
      })(),
    );
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(tracked.inFlight, 2);
    inner.release();
    await Promise.allSettled(drains);
    assert.equal(tracked.inFlight, 0);
  });

  it("decrementa si el stream falla a mitad", async () => {
    const tracked = new TrackedExec(new FailExec());
    await assert.rejects(async () => {
      for await (const _ of tracked.execute(req())) {
        /* consume */
      }
    });
    assert.equal(tracked.inFlight, 0);
  });

  it("decrementa si el consumer cancela el stream (break)", async () => {
    const inner = new BlockingExec();
    const tracked = new TrackedExec(inner);
    for await (const _ of tracked.execute(req())) {
      break; // cancelación del consumer: el finally igual corre
    }
    assert.equal(tracked.inFlight, 0);
  });

  it("no cuenta si execute() se llama pero nunca se consume", () => {
    const tracked = new TrackedExec(new BlockingExec());
    tracked.execute(req()); // lazy: no arrancó
    assert.equal(tracked.inFlight, 0);
  });

  it("delega forgeId/model/probe/resident al inner", async () => {
    const inner = new BlockingExec();
    const tracked = new TrackedExec(inner);
    assert.equal(tracked.forgeId, "blocking");
    assert.equal(tracked.model, "qwen3:4b");
    assert.equal(await tracked.probe?.(), true); // ausente en inner → suponé vivo
  });
});
