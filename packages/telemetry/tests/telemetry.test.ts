// S9a — Telemetry en memoria: record + recent (novedades primero) + p50 intacto.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InMemoryTelemetry } from "../src/ports.ts";

describe("S9a telemetry", () => {
  it("recent devuelve las últimas primero", () => {
    const t = new InMemoryTelemetry();
    t.record({ forgeId: "a", model: "m", ttftMs: 100, ok: true, ts: 1 });
    t.record({ forgeId: "a", model: "m", ttftMs: 300, ok: true, ts: 2 });
    t.record({ forgeId: "a", model: "m", ttftMs: 200, ok: true, ts: 3 });
    assert.deepEqual(t.recent(2).map((s) => s.ttftMs), [200, 300]);
    assert.equal(t.p50("m"), 200);
  });

  it("vacío → recent [] y p50 0", () => {
    const t = new InMemoryTelemetry();
    assert.deepEqual(t.recent(5), []);
    assert.equal(t.p50("m"), 0);
  });
});
