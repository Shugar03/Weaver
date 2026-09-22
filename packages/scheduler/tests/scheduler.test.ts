// S1 — Scheduler elige HOT aunque el COLD tenga mismo RTT/queue.
// Fuente independiente: literales fijos, no recalculamos con el código.
// Rojo original: sin scheduler, este test fallaba (no existía el Module).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EtrScheduler } from "../src/scheduler.ts";

describe("S1 warm-first", () => {
  it("elige forge-hot frente a forge-cold con mismo RTT/queue", () => {
    const s = new EtrScheduler();
    const d = s.select({ id: "j1", model: "qwen3.5:4b" }, [
      { forgeId: "forge-cold", model: "qwen3.5:4b", hot: false, rttMs: 50, queueMs: 100, loadTimeMs: 20000, price: 0.008, reliability: 0.99 },
      { forgeId: "forge-hot", model: "qwen3.5:4b", hot: true, rttMs: 50, queueMs: 100, loadTimeMs: 20000, price: 0.01, reliability: 0.99 },
    ]);
    assert.equal(d.forgeId, "forge-hot");
    assert.equal(d.etrMs, 50 + 100 + 0);
    assert.equal(d.reason, "warm-first");
  });

  it("falla explícito sin candidatos (error, no undefined)", () => {
    const s = new EtrScheduler();
    assert.throws(() => s.select({ id: "j2", model: "qwen3.5:4b" }, []), /sin forges/);
  });
});

describe("S20 ETR medido", () => {
  it("measuredTtftMs reemplaza el estimado y gana con reason measured", () => {
    const s = new EtrScheduler();
    const d = s.select({ id: "j", model: "m" }, [
      { forgeId: "estimado", model: "m", hot: true, rttMs: 50, queueMs: 0, loadTimeMs: 0, price: 0, reliability: 1 },
      { forgeId: "medido", model: "m", hot: true, rttMs: 500, queueMs: 0, loadTimeMs: 0, price: 0, reliability: 1, measuredTtftMs: 8 },
    ]);
    assert.equal(d.forgeId, "medido");
    assert.equal(d.etrMs, 8);
    assert.equal(d.reason, "measured");
  });

  it("forge frío con measured viejo NO lo usa (stale no tapa el load)", () => {
    const s = new EtrScheduler();
    const d = s.select({ id: "j", model: "m" }, [
      { forgeId: "frio", model: "m", hot: false, rttMs: 5, queueMs: 0, loadTimeMs: 2000, price: 0, reliability: 1, measuredTtftMs: 8 },
      { forgeId: "tibio", model: "m", hot: true, rttMs: 50, queueMs: 0, loadTimeMs: 0, price: 0, reliability: 1 },
    ]);
    assert.equal(d.forgeId, "tibio");
    assert.equal(d.reason, "warm-first");
  });
});
