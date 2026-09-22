// S9a — el gateway registra cada chat en telemetry y expone executions + status.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.ts";
import { FailoverForgeExec, FakeForgeExec } from "@weaver/forge-exec";
import type { ExecRequest, ForgeExec, StreamChunk } from "@weaver/forge-exec";
import { InMemoryTelemetry } from "@weaver/telemetry";
import type { Sample } from "@weaver/telemetry";

const view = (forgeId: string) => ({
  forgeId,
  model: "qwen3:4b",
  hot: true,
  rttMs: 1,
  queueMs: 0,
  loadTimeMs: 0,
  price: 0,
  reliability: 1,
});
const forges = () => [view("fake-forge")];

class DeadExec implements ForgeExec {
  readonly forgeId = "dead";
  readonly model = "qwen3:4b";
  async *execute(_req: ExecRequest): AsyncIterable<StreamChunk> {
    throw new Error("caído");
  }
}

async function runChat(app: { request: (input: string, init?: RequestInit) => Response | Promise<Response> }) {
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
    const app = createApp({ forges, exec: new FakeForgeExec(), telemetry });
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

  it("S19: el sample lleva el forge que sirvió (onForge), no el primario muerto", async () => {
    const telemetry = new InMemoryTelemetry();
    const app = createApp({
      forges: () => [view("dead"), view("segundo")],
      exec: new FailoverForgeExec([new DeadExec(), new FakeForgeExec({ forgeId: "segundo" })]),
      telemetry,
    });
    await runChat(app);
    const list = (await (await app.request("/v1/executions")).json()) as Sample[];
    assert.equal(list[0].forgeId, "segundo");
  });

  it("sin telemetry → executions [] sin romper", async () => {
    const app = createApp({ forges: () => [] });
    const res = await app.request("/v1/executions");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), []);
  });

  it("?forgeId= filtra server-side: solo los samples de ese forge", async () => {
    const telemetry = new InMemoryTelemetry();
    const rec = (forgeId: string) =>
      telemetry.record({ forgeId, model: "qwen3:4b", ttftMs: 100, ok: true, ts: Date.now() });
    await rec("ollama-local");
    await rec("image-local");
    await rec("ollama-local");
    const app = createApp({ forges, telemetry });
    const all = (await (await app.request("/v1/executions")).json()) as Sample[];
    assert.equal(all.length, 3);
    const only = (await (await app.request("/v1/executions?forgeId=image-local")).json()) as Sample[];
    assert.equal(only.length, 1);
    assert.equal(only[0].forgeId, "image-local");
    const none = (await (await app.request("/v1/executions?forgeId=nadie")).json()) as Sample[];
    assert.equal(none.length, 0);
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
