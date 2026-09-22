// S7 — kill switch del dashboard: flipea el flag, sin flag → 404.
// S26: kill granular — {forgeId} mata ese forge; sin forgeId = primary (compat).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.ts";

describe("S7 kill switch", () => {
  it("POST /v1/admin/kill flipea dead (sin forgeId = default del root)", async () => {
    const calls: [string | undefined, boolean][] = [];
    const app = createApp({
      forges: () => [],
      chaos: { setDead: (id: string | undefined, d: boolean) => { calls.push([id, d]); return true; } },
    });
    const res = await app.request("/v1/admin/kill", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dead: true }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(calls, [[undefined, true]]);
    assert.deepEqual(await res.json(), { dead: true });
  });

  it("kill granular: forgeId viaja al chaos dep y responde {dead, forgeId}", async () => {
    const calls: [string | undefined, boolean][] = [];
    const app = createApp({
      forges: () => [],
      chaos: { setDead: (id: string | undefined, d: boolean) => { calls.push([id, d]); return id === "gemma-local"; } },
    });
    const res = await app.request("/v1/admin/kill", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dead: true, forgeId: "gemma-local" }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(calls, [["gemma-local", true]]);
    assert.deepEqual(await res.json(), { dead: true, forgeId: "gemma-local" });
  });

  it("forgeId que el root no controla → 404 honesto", async () => {
    const app = createApp({
      forges: () => [],
      chaos: { setDead: () => false },
    });
    const res = await app.request("/v1/admin/kill", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dead: true, forgeId: "inexistente" }),
    });
    assert.equal(res.status, 404);
  });

  it("sin chaos en Deps → 404", async () => {
    const app = createApp({ forges: () => [] });
    const res = await app.request("/v1/admin/kill", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 404);
  });
});
