// S17a — metering por key: jobs, ok, okRate, spentUSDC (ok × $0.01).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InMemoryTelemetry } from "../src/ports.ts";

async function seed() {
  const t = new InMemoryTelemetry();
  await t.record({ forgeId: "a", model: "m", ttftMs: 100, ok: true, ts: 1, keyId: "k1" });
  await t.record({ forgeId: "a", model: "m", ttftMs: 200, ok: true, ts: 2, keyId: "k1" });
  await t.record({ forgeId: "a", model: "m", ttftMs: 300, ok: false, ts: 3, keyId: "k1" });
  await t.record({ forgeId: "b", model: "m", ttftMs: 400, ok: true, ts: 4, keyId: "k2" });
  return t;
}

describe("S17a usage", () => {
  it("por key: cuenta jobs/ok/rate/spent", async () => {
    const u = await (await seed()).usage("k1");
    assert.deepEqual(u, { jobs: 3, ok: 2, okRate: 2 / 3, spentUSDC: 0.02 });
  });
  it("sin key: todo el nodo", async () => {
    const u = await (await seed()).usage();
    assert.deepEqual(u, { jobs: 4, ok: 3, okRate: 0.75, spentUSDC: 0.03 });
  });
  it("key sin jobs → ceros", async () => {
    const u = await (await seed()).usage("nadie");
    assert.deepEqual(u, { jobs: 0, ok: 0, okRate: 0, spentUSDC: 0 });
  });
});
