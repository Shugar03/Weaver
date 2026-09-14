// S7 — CORS abierto para el dashboard (:3000 → :3101).
// Sin esto el browser bloquea todo (los tests app.request y curl no lo ven).
// El preflight OPTIONS debe pasar ANTES que el paywall 402.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.ts";
import { FakeVerifier } from "@weaver/settlement";

const paywall = { verifier: new FakeVerifier(), payTo: "GTEST" };

describe("S7 CORS dashboard", () => {
  it("preflight OPTIONS responde ACAO sin pasar por paywall", async () => {
    const app = createApp({ forges: () => [], paywall });
    const res = await app.request("/v1/jobs", {
      method: "OPTIONS",
      headers: { origin: "http://localhost:3000", "access-control-request-method": "POST" },
    });
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
  });

  it("respuestas reales llevan ACAO (402 con paywall incluido)", async () => {
    const app = createApp({ forges: () => [], paywall });
    const res = await app.request("/v1/jobs", {
      method: "POST",
      headers: { origin: "http://localhost:3000", "content-type": "application/json" },
      body: JSON.stringify({ model: "qwen3:4b" }),
    });
    assert.equal(res.status, 402);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
  });
});
