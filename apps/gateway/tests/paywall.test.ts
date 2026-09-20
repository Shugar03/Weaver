// S4 — paywall x402 en gateway: 402 con accepts sin pago, 200 con proof válido.
// Opt-in por composición: sin paywall en Deps, todo abierto (S2 intacto).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.ts";
import { FakeVerifier } from "@weaver/settlement";

const forges = () => [
  { forgeId: "forge-hot", model: "qwen3.5:4b", hot: true, rttMs: 50, queueMs: 100, loadTimeMs: 0, price: 0.01, reliability: 0.99 },
];
const paywall = { verifier: new FakeVerifier(), payTo: "GTESTPAYTO" };
const jobsBody = JSON.stringify({ model: "qwen3.5:4b" });
const json = { "content-type": "application/json" };

describe("S4 paywall x402", () => {
  it("sin header → 402 con accepts stellar:testnet $0.01", async () => {
    const app = createApp({ forges, paywall });
    const res = await app.request("/v1/jobs", { method: "POST", headers: json, body: jobsBody });
    assert.equal(res.status, 402);
    const body = (await res.json()) as { accepts: { scheme: string; network: string; price: string; payTo: string }[] };
    assert.equal(body.accepts[0].scheme, "exact");
    assert.equal(body.accepts[0].network, "stellar:testnet");
    assert.equal(body.accepts[0].price, "$0.01");
    assert.equal(body.accepts[0].payTo, "GTESTPAYTO");
  });

  it("header válido → 200", async () => {
    const app = createApp({ forges, paywall });
    const res = await app.request("/v1/jobs", {
      method: "POST",
      headers: { ...json, "x-payment": "valid-proof" },
      body: jobsBody,
    });
    assert.equal(res.status, 200);
  });

  it("header trucho → 402", async () => {
    const app = createApp({ forges, paywall });
    const res = await app.request("/v1/jobs", {
      method: "POST",
      headers: { ...json, "x-payment": "trucho" },
      body: jobsBody,
    });
    assert.equal(res.status, 402);
  });

  it("sin paywall en Deps → abierto (compat S2)", async () => {
    const app = createApp({ forges });
    const res = await app.request("/v1/jobs", { method: "POST", headers: json, body: jobsBody });
    assert.equal(res.status, 200);
  });

  it("S15a: descubrimiento abierto con paywall (GETs no se cobran)", async () => {
    const app = createApp({ forges, paywall });
    assert.equal((await app.request("/v1/forges")).status, 200);
    assert.equal((await app.request("/v1/models")).status, 200);
    assert.equal((await app.request("/v1/status")).status, 200);
  });

  it("S15a: POST /v1/chat/completions también cobra", async () => {
    const app = createApp({ forges, paywall });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ model: "qwen3.5:4b", messages: [] }),
    });
    assert.equal(res.status, 402);
  });
});
