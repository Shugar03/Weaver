// S3 — OllamaMLXAdapter con fetch inyectado: sin necesitar Ollama corriendo.
// Verifica mapeo SSE→chunks, URL/modelo correctos y error ante HTTP no-ok.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OllamaMLXAdapter } from "../src/ollama.ts";
import type { StreamChunk } from "../src/ports.ts";

const SSE = `data: {"choices":[{"delta":{"content":"hola "}}]}\n\ndata: {"choices":[{"delta":{"content":"mundo"}}]}\n\ndata: [DONE]\n\n`;

function fakeFetch(seen: { url?: string; body?: Record<string, unknown> }, status = 200) {
  return async (url: string, init: RequestInit): Promise<Response> => {
    seen.url = url;
    seen.body = JSON.parse(init.body as string) as Record<string, unknown>;
    return new Response(SSE, { status, headers: { "content-type": "text/event-stream" } });
  };
}

async function collect(exec: { execute(r: { jobId: string; model: string; prompt: string }): AsyncIterable<StreamChunk> }) {
  let out = "";
  let done = false;
  for await (const c of exec.execute({ jobId: "j", model: "qwen3.5:4b", prompt: "hola" })) {
    out += c.token;
    done = c.done;
  }
  return { out, done };
}

describe("S3 OllamaMLXAdapter", () => {
  it("mapea SSE a tokens y termina", async () => {
    const seen: { url?: string; body?: Record<string, unknown> } = {};
    const a = new OllamaMLXAdapter({ fetchFn: fakeFetch(seen) });
    const { out, done } = await collect(a);
    assert.equal(out, "hola mundo");
    assert.equal(done, true);
  });

  it("pega a /v1/chat/completions con modelo y stream:true", async () => {
    const seen: { url?: string; body?: Record<string, unknown> } = {};
    const a = new OllamaMLXAdapter({ model: "qwen3.5:4b", fetchFn: fakeFetch(seen) });
    await collect(a);
    assert.equal(seen.url, "http://localhost:11434/v1/chat/completions");
    assert.equal(seen.body?.["model"], "qwen3.5:4b");
    assert.equal(seen.body?.["stream"], true);
  });

  it("HTTP 500 → throw con estado", async () => {
    const seen: { url?: string; body?: Record<string, unknown> } = {};
    const a = new OllamaMLXAdapter({ fetchFn: fakeFetch(seen, 500) });
    await assert.rejects(collect(a), /500/);
  });
});
