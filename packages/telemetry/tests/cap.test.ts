// S11 — telemetry con tope: lo viejo se evicta, lo nuevo entra. Sin DoS lento.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InMemoryTelemetry } from "../src/ports.ts";

describe("S11 cap telemetry", () => {
  it("más de 500 samples → solo viven los últimos 500", () => {
    const t = new InMemoryTelemetry();
    for (let i = 0; i < 503; i++) t.record({ forgeId: "a", model: "m", ttftMs: i, ok: true, ts: i });
    assert.equal(t.recent(1000).length, 500);
    assert.equal(t.recent(1)[0].ttftMs, 502);
  });
});
