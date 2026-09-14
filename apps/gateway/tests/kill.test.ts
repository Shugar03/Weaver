// S7 — kill switch del dashboard: flipea el flag, sin flag → 404.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.ts";

describe("S7 kill switch", () => {
  it("POST /v1/admin/kill flipea dead", async () => {
    let dead = false;
    const app = createApp({ forges: () => [], chaos: { setDead: (d: boolean) => { dead = d; } } });
    const res = await app.request("/v1/admin/kill", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dead: true }),
    });
    assert.equal(res.status, 200);
    assert.equal(dead, true);
    assert.deepEqual(await res.json(), { dead: true });
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
