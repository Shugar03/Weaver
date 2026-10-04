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
      // recent ordena por id DESC (más reciente insertado primero): ts=3 (ttft
      // 200) antes que ts=2 (ttft 300).
      assert.deepEqual((await t.recent(2)).map((s) => s.ttftMs), [200, 300]);
      assert.equal(await t.p50("m", "a"), 200);
      assert.deepEqual(await t.usage(), { jobs: 3, ok: 3, okRate: 1, spentUSDC: 0.03 });
    } finally {
      await db.delete(performanceSamples);
      await closeDb();
    }
  });

  it("spec 009 — receipt fields round-trip + findByJobId", { skip: !URL }, async () => {
    const db = dbFromUrl(URL as string);
    await db.delete(performanceSamples);
    try {
      const t = new PostgresTelemetry(db);
      await t.record({
        forgeId: "f1",
        model: "m",
        ttftMs: 42,
        ok: true,
        ts: 1,
        jobId: "chatcmpl-abc",
        resultHash: "aa".repeat(32),
        proofSig: "0xbb",
        settle: { status: "settled", releaseTx: "0xrel" },
      });
      await t.record({ forgeId: "f1", model: "m", ttftMs: 10, ok: false, ts: 2 }); // sin receipt
      const s = await t.findByJobId("chatcmpl-abc");
      assert.equal(s?.resultHash, "aa".repeat(32));
      assert.equal(s?.proofSig, "0xbb");
      assert.equal(s?.settle?.releaseTx, "0xrel");
      assert.equal(await t.findByJobId("chatcmpl-nope"), null);
      // recent también expone los campos
      assert.equal((await t.recent(2))[1].jobId, "chatcmpl-abc");
      assert.equal((await t.recent(2))[0].jobId, undefined); // el fail no lleva
    } finally {
      await db.delete(performanceSamples);
      await closeDb();
    }
  });

  it("sin TEST_DATABASE_URL los tests de pg se saltean (CI verde sin DB)", () => {
    // Cuando URL no está, los tests de arriba llevan skip — el archivo queda
    // verde sin Postgres. Cuando está, es una URL postgres válida.
    assert.ok(URL === undefined || (typeof URL === "string" && URL.startsWith("postgres")));
  });
});
