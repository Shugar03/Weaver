// S9a — el gateway registra cada chat en telemetry y expone executions + status.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.ts";
import { FakeForgeExec } from "@weaver/forge-exec";
import { InMemoryTelemetry } from "@weaver/telemetry";
import type { Sample } from "@weaver/telemetry";

async function runChat(app: { request: (input: string, init?: RequestInit) => Promise<Response> }) {
  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "qwen3:4b", messages: [{ role: "user", content: "hola" }], stream: true }),
  });
  assert.equal(res.status, 200);
  await res.text(); // drena el stream para que se registre el done
}

describe("S9a executions", () => {
  it("un chat completo deja 1 sample ok con forge y ttft", async () => {
    const telemetry = new InMemoryTelemetry();
    const app = createApp({ forges: () => [], exec: new FakeForgeExec(), telemetry });
    await runChat(app);
    const res = await app.request("/v1/executions?limit=10");
    assert.equal(res.status, 200);
    const list = (await res.json()) as Sample[];
    assert.equal(list.length, 1);
    assert.equal(list[0].forgeId, "fake-forge");
    assert.equal(list[0].model, "qwen3:4b");
    assert.equal(list[0].ok, true);
    assert.ok(list[0].ttftMs >= 0);
  });

  it("sin telemetry → executions [] sin romper", async () => {
    const app = createApp({ forges: () => [] });
    const res = await app.request("/v1/executions");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), []);
  });
});

describe("S9a status", () => {
  it("expone versión y uptime del nodo", async () => {
    const app = createApp({ forges: () => [], node: { version: "0.1.0-test", startedAt: Date.now() - 5000 } });
    const res = await app.request("/v1/status");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { version: string; uptimeMs: number };
    assert.equal(body.version, "0.1.0-test");
    assert.ok(body.uptimeMs >= 5000);
  });
});
