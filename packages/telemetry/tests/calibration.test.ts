// packages/telemetry/tests/calibration.test.ts — contraste ETR predicho vs
// real por forge. El claim "measured, not declared" se vuelve verificable:
// sin samples calibrables → null (la UI muestra "—", jamás inventa).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { etrCalibration } from "../src/calibration.ts";
import type { Sample } from "../src/ports.ts";

const s = (over: Partial<Sample>): Sample => ({
  forgeId: "f1",
  model: "m",
  ttftMs: 500,
  ok: true,
  ts: Date.now(),
  ...over,
});

describe("etrCalibration", () => {
  it("sin samples calibrables → null (nada que contrastar)", () => {
    assert.equal(etrCalibration([], "f1"), null);
    assert.equal(etrCalibration([s({})], "f1"), null); // sin predictedMs
    assert.equal(etrCalibration([s({ predictedMs: 900, ok: false })], "f1"), null); // fallido no calibra
  });

  it("un solo par predicho→real da el error relativo", () => {
    const c = etrCalibration([s({ predictedMs: 1000, ttftMs: 800, decodeMs: 200 })], "f1");
    assert.ok(c);
    // actual = ttft + decode = 1000 → error 0%
    assert.equal(c.errPct, 0);
    assert.equal(c.lastPredMs, 1000);
    assert.equal(c.lastActualMs, 1000);
  });

  it("error relativo = |pred-actual|/actual, con EMA sobre la ventana", () => {
    const samples = [
      s({ predictedMs: 2000, ttftMs: 800, decodeMs: 200, ts: 1 }), // act=1000, err=100%
      s({ predictedMs: 1000, ttftMs: 800, decodeMs: 200, ts: 2 }), // act=1000, err=0%
    ];
    const c = etrCalibration(samples, "f1");
    assert.ok(c);
    // EMA α=0.3 (convención del sistema): 0.7*100% + 0.3*0% = 70%
    assert.equal(Math.round(c.errPct!), 70);
    assert.equal(c.lastActualMs, 1000);
  });

  it("sin decodeMs el actual es el ttft solo (job sin stats)", () => {
    const c = etrCalibration([s({ predictedMs: 900, ttftMs: 600 })], "f1");
    // act=600 → err=|900-600|/600=50%
    assert.equal(c!.errPct, 50);
  });

  it("solo cuenta samples del forge pedido", () => {
    const c = etrCalibration(
      [s({ predictedMs: 100, forgeId: "otro", ttftMs: 100 }), s({ predictedMs: 500, ttftMs: 400, decodeMs: 100 })],
      "f1",
    );
    assert.equal(c!.lastPredMs, 500);
  });
});
