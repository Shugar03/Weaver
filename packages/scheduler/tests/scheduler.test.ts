// S1 — Scheduler elige HOT aunque el COLD tenga mismo RTT/queue.
// Fuente independiente: literales fijos, no recalculamos con el código.
// Rojo original: sin scheduler, este test fallaba (no existía el Module).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EtrScheduler } from "../src/scheduler.ts";

describe("S1 warm-first", () => {
  it("elige forge-hot frente a forge-cold con mismo RTT/queue", () => {
    const s = new EtrScheduler();
    const d = s.select({ id: "j1", model: "qwen3.5:4b", estGenMs: 800 }, [
      { forgeId: "forge-cold", model: "qwen3.5:4b", hot: false, rttMs: 50, queueMs: 100, loadTimeMs: 20000, price: 0.008, reliability: 0.99 },
      { forgeId: "forge-hot", model: "qwen3.5:4b", hot: true, rttMs: 50, queueMs: 100, loadTimeMs: 20000, price: 0.01, reliability: 0.99 },
    ]);
    assert.equal(d.forgeId, "forge-hot");
    assert.equal(d.etrMs, 50 + 100 + 0 + 800);
    assert.equal(d.reason, "warm-first");
  });

  it("falla explícito sin candidatos (error, no undefined)", () => {
    const s = new EtrScheduler();
    assert.throws(() => s.select({ id: "j2", model: "qwen3.5:4b" }, []), /sin forges/);
  });
});
