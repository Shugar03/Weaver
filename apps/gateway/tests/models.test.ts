// S8b — GET /v1/models formato lista OpenAI (lo que opencode/cursor leen para descubrir).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.ts";

const forges = () => [
  { forgeId: "ollama-local", model: "qwen3:4b", hot: true, rttMs: 5, queueMs: 0, loadTimeMs: 0, price: 0, reliability: 1 },
  { forgeId: "forge-sim-01", model: "qwen3:4b", hot: false, rttMs: 140, queueMs: 2, loadTimeMs: 4000, price: 0.0004, reliability: 0.99, sim: true },
];

describe("S8b GET /v1/models", () => {
  it("lista OpenAI con modelos únicos de la fleet", async () => {
    const app = createApp({ forges });
    const res = await app.request("/v1/models");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { object: string; data: { id: string; object: string; owned_by: string }[] };
    assert.equal(body.object, "list");
    assert.deepEqual(body.data, [{ id: "qwen3:4b", object: "model", owned_by: "weaver" }]);
  });

  it("sin forges → lista vacía, no 500", async () => {
    const app = createApp({ forges: () => [] });
    const res = await app.request("/v1/models");
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()) as unknown, { object: "list", data: [] });
  });
});
