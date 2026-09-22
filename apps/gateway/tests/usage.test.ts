// S17a — GET /v1/usage: metering por key (o nodo). Lo que S17b/c van a liquidar.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.ts";
import { FakeForgeExec } from "@weaver/forge-exec";
import { InMemoryTelemetry } from "@weaver/telemetry";
import { InMemoryApiKeys } from "@weaver/api-keys";

// S19: chat exige que el modelo exista en la fleet.
const forges = () => [
  { forgeId: "fake-forge", model: "qwen3:4b", hot: true, rttMs: 1, queueMs: 0, loadTimeMs: 0, price: 0, reliability: 1 },
];

describe("S17a usage", () => {
  it("2 chats ok → usage {jobs 2, spent 0.02}", async () => {
    const app = createApp({ forges, exec: new FakeForgeExec(), telemetry: new InMemoryTelemetry() });
    const body = JSON.stringify({ model: "qwen3:4b", messages: [{ role: "user", content: "hola" }] });
    for (let i = 0; i < 2; i++) {
      const res = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      await res.text(); // drena el stream para que se registre
    }
    const res = await app.request("/v1/usage");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { jobs: 2, ok: 2, okRate: 1, spentUSDC: 0.02 });
  });

  it("filtra por keyId (Bearer verificado)", async () => {
    const apiKeys = new InMemoryApiKeys();
    const telemetry = new InMemoryTelemetry();
    const app = createApp({ forges, exec: new FakeForgeExec(), telemetry, apiKeys });
    const { id, secret } = await apiKeys.issue("dueno");
    const body = JSON.stringify({ model: "qwen3:4b", messages: [{ role: "user", content: "hola" }] });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body,
    });
    await res.text();
    const usage = await (await app.request(`/v1/usage?keyId=${id}`)).json();
    assert.deepEqual(usage, { jobs: 1, ok: 1, okRate: 1, spentUSDC: 0.01 });
  });

  it("sin telemetry → ceros, no 500", async () => {
    const app = createApp({ forges: () => [] });
    const res = await app.request("/v1/usage?keyId=k1");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { jobs: 0, ok: 0, okRate: 0, spentUSDC: 0 });
  });
});
