// S16a — PostgresTelemetry contra DB real. Requiere TEST_DATABASE_URL;
// sin ella, skip — CI sigue verde sin DB.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { closeDb, dbFromUrl, performanceSamples } from "@weaver/db";
import { PostgresTelemetry } from "../src/postgres.ts";

const URL = process.env.TEST_DATABASE_URL;

describe("S16a PostgresTelemetry", () => {
  it("round-trip record/recent/p50", { skip: !URL }, async () => {
    const db = dbFromUrl(URL as string);
    await db.delete(performanceSamples);
    try {
      const t = new PostgresTelemetry(db);
      await t.record({ forgeId: "a", model: "m", ttftMs: 100, ok: true, ts: 1 });
      await t.record({ forgeId: "a", model: "m", ttftMs: 300, ok: true, ts: 2 });
      await t.record({ forgeId: "a", model: "m", ttftMs: 200, ok: true, ts: 3 });
      assert.deepEqual((await t.recent(2)).map((s) => s.ttftMs), [300, 200]);
      assert.equal(await t.p50("m", "a"), 200);
      assert.deepEqual(await t.usage(), { jobs: 3, ok: 3, okRate: 1, spentUSDC: 0.03 });
    } finally {
      await db.delete(performanceSamples);
      await closeDb();
    }
  });

  it("sin TEST_DATABASE_URL se declara el skip", () => {
    assert.equal(Boolean(URL), false);
  });
});
