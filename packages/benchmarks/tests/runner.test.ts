// S6 — runner con clock inyectado: tiempos deterministas, sin red.
// Fakes que avanzan el reloj a mano → asserts exactos, nada de flakiness.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { measure, runBench } from "../src/runner.ts";
import type { ChatTarget, Chunk } from "../src/types.ts";

function scripted(name: string, steps: (number | Error)[], text = "tok"): ChatTarget {
  return {
    name,
    async *chat(_prompt: string): AsyncIterable<Chunk> {
      for (const s of steps) {
        if (s instanceof Error) throw s;
        tick(s);
        yield { token: text, done: false };
      }
      tick(50);
      yield { token: "", done: true };
    },
  };
}

// Reloj manual compartido con los targets de arriba.
let now = 0;
function tick(ms: number) {
  now += ms;
}
const clock = () => now;

describe("S6 measure", () => {
  it("ttft = primer token, total = fin (120 / 400)", async () => {
    now = 1000;
    const m = await measure(scripted("a", [120, 130, 100]), "hola", clock);
    assert.equal(m.ok, true);
    assert.equal(m.ttftMs, 120);
    assert.equal(m.totalMs, 400);
    assert.equal(m.chars, 9);
  });

  it("target que muere → ok:false con error, sin throw", async () => {
    now = 0;
    const m = await measure(scripted("muerto", [new Error("boom")]), "hola", clock);
    assert.equal(m.ok, false);
    assert.match(m.error ?? "", /boom/);
  });
});

describe("S6 summarize", () => {
  it("p50 sobre 3 muestras + success rate", async () => {
    now = 0;
    const fast = scripted("fast", [100]);
    const results = await runBench([fast], ["p1", "p2", "p3"], clock);
    assert.equal(results.length, 1);
    assert.equal(results[0].n, 3);
    assert.equal(results[0].ok, 3);
    assert.equal(results[0].p50ttft, 100);
  });

  it("un muerto entre 3 → ok 2/3", async () => {
    let calls = 0;
    const flaky: ChatTarget = {
      name: "flaky",
      async *chat(_p: string): AsyncIterable<Chunk> {
        calls++;
        if (calls === 2) throw new Error("caído");
        yield { token: "x", done: false };
        yield { token: "", done: true };
      },
    };
    const results = await runBench([flaky], ["p1", "p2", "p3"], clock);
    assert.equal(results[0].ok, 2);
  });
});
