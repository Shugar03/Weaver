// S2 — Seam HTTP routing. Valores literales fijos, sin recálculo.
// Ojo honesto: /v1/jobs ya existía del scaffold, estos tests lo lockean;
// /v1/chat/completions es el verdadero rojo (todavía no existe la ruta).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.ts";

const forges = () => [
  { forgeId: "forge-cold", model: "qwen3.5:4b", hot: false, rttMs: 50, queueMs: 100, loadTimeMs: 20000, price: 0.008, reliability: 0.99 },
  { forgeId: "forge-hot", model: "qwen3.5:4b", hot: true, rttMs: 50, queueMs: 100, loadTimeMs: 20000, price: 0.01, reliability: 0.99 },
];

describe("S2 POST /v1/jobs", () => {
  it("responde forge-hot con etr_ms 150 y reason warm-first", async () => {
    const app = createApp({ forges });
    const res = await app.request("/v1/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "qwen3.5:4b" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { forge: string; etr_ms: number; reason: string };
    assert.equal(body.forge, "forge-hot");
    assert.equal(body.etr_ms, 150);
    assert.equal(body.reason, "warm-first");
  });

  it("GET /v1/forges lista lo que da el provider", async () => {
    const app = createApp({ forges });
    const res = await app.request("/v1/forges");
    assert.equal(res.status, 200);
    const body = (await res.json()) as unknown[];
    assert.equal(body.length, 2);
  });

  it("S19: modelo sin forges → 404 unknown_model, no 500", async () => {
    const app = createApp({ forges });
    const res = await app.request("/v1/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "inexistente" }),
    });
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { code: string }).code, "unknown_model");
  });
});
