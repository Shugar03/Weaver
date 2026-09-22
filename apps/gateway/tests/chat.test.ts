// S2 — POST /v1/chat/completions SSE con FakeForgeExec (verdadero rojo).
// S19: el modelo pedido debe existir en la fleet — si no, 404 antes de ejecutar.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.ts";
import { FakeForgeExec } from "@weaver/forge-exec";
import type { ExecRequest, ForgeExec, StreamChunk } from "@weaver/forge-exec";

const forges = () => [
  { forgeId: "fake-forge", model: "qwen3.5:4b", hot: true, rttMs: 1, queueMs: 0, loadTimeMs: 0, price: 0, reliability: 1 },
];

class CountingExec implements ForgeExec {
  readonly forgeId = "counting";
  readonly model = "qwen3.5:4b";
  calls = 0;
  async *execute(_req: ExecRequest): AsyncIterable<StreamChunk> {
    this.calls++;
    yield { token: "nunca", done: false };
    yield { token: "", done: true };
  }
}

describe("S2 SSE completions", () => {
  it("streamea chunks OpenAI-compatibles y cierra con [DONE]", async () => {
    const app = createApp({ forges, exec: new FakeForgeExec() });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "qwen3.5:4b", messages: [{ role: "user", content: "hola forge" }], stream: true }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    const text = await res.text();
    assert.ok(text.includes("hola forge"));
    assert.ok(text.includes("[DONE]"));
  });
});

describe("S19 modelo desconocido", () => {
  it("chat con model que nadie sirve → 404 unknown_model, sin ejecutar", async () => {
    const exec = new CountingExec();
    const app = createApp({ forges, exec });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hola" }] }),
    });
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { code: string }).code, "unknown_model");
    assert.equal(exec.calls, 0);
  });

  it("chat con un modelo de IMAGEN → 404, jamás dispatch cruzado", async () => {
    const mixed = () => [
      { forgeId: "fake-forge", model: "qwen3.5:4b", hot: true, rttMs: 1, queueMs: 0, loadTimeMs: 0, price: 0, reliability: 1 },
      { forgeId: "image-local", model: "flux2-klein-4b", capability: "image" as const, hot: false, rttMs: 5, queueMs: 0, loadTimeMs: 20_000, price: 0, reliability: 1 },
    ];
    const exec = new CountingExec();
    const app = createApp({ forges: mixed, exec });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "flux2-klein-4b", messages: [{ role: "user", content: "hola" }] }),
    });
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { code: string }).code, "unknown_model");
    assert.equal(exec.calls, 0);
  });
});
