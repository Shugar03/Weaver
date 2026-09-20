// S9a — Telemetry en memoria: record + recent (novedades primero) + p50 intacto.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InMemoryTelemetry } from "../src/ports.ts";

describe("S9a telemetry", () => {
  it("recent devuelve las últimas primero", async () => {
    const t = new InMemoryTelemetry();
    await t.record({ forgeId: "a", model: "m", ttftMs: 100, ok: true, ts: 1 });
    await t.record({ forgeId: "a", model: "m", ttftMs: 300, ok: true, ts: 2 });
    await t.record({ forgeId: "a", model: "m", ttftMs: 200, ok: true, ts: 3 });
    assert.deepEqual((await t.recent(2)).map((s) => s.ttftMs), [200, 300]);
    assert.equal(await t.p50("m"), 200);
  });

  it("vacío → recent [] y p50 0", async () => {
    const t = new InMemoryTelemetry();
    assert.deepEqual(await t.recent(5), []);
    assert.equal(await t.p50("m"), 0);
  });
});
