// S16a — PostgresApiKeys contra DB real. Requiere TEST_DATABASE_URL
// (Supabase o pg local); sin ella, skip — CI sigue verde sin DB.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { apiKeys, closeDb, dbFromUrl } from "@weaver/db";
import { PostgresApiKeys } from "../src/postgres.ts";

const URL = process.env.TEST_DATABASE_URL;

describe("S16a PostgresApiKeys", () => {
  it("round-trip issue/verify/revoke/list/seed", { skip: !URL }, async () => {
    const db = dbFromUrl(URL as string);
    await db.delete(apiKeys);
    try {
      const store = new PostgresApiKeys(db);
      const { id, secret } = await store.issue("jurado");
      assert.ok(secret.startsWith("wvr_"));
      assert.deepEqual(await store.verify(secret), { id, owner: "jurado" });
      const seeded = await store.seed("operator", "wvr_fija_test");
      assert.deepEqual(await store.verify("wvr_fija_test"), { id: seeded.id, owner: "operator" });
      assert.equal((await store.list()).length, 2);
      assert.equal(await store.revoke(id), true);
      assert.equal(await store.verify(secret), null);
      const raw = JSON.stringify(await store.list());
      assert.ok(!raw.includes(secret.slice(4, 12)));
    } finally {
      await db.delete(apiKeys);
      await closeDb();
    }
  });

  it("sin TEST_DATABASE_URL se declara el skip", () => {
    assert.equal(Boolean(URL), false);
  });
});
