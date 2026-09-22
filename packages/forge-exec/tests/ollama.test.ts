// S3 — OllamaMLXAdapter con fetch inyectado: sin necesitar Ollama corriendo.
// Verifica mapeo NDJSON→chunks (thinking + content separados), URL/modelo
// correctos, keep_alive/think/options y error ante HTTP no-ok.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OllamaMLXAdapter } from "../src/ollama.ts";
import type { StreamChunk } from "../src/ports.ts";

const NDJSON =
  `{"message":{"role":"assistant","thinking":"pensando... "}}\n` +
  `{"message":{"role":"assistant","content":"hola "}}\n` +
  `{"message":{"role":"assistant","content":"mundo"}}\n` +
  `{"done":true,"prompt_eval_count":9,"eval_count":4,"load_duration":1000000,"prompt_eval_duration":2000000,"eval_duration":3000000}\n`;

function fakeFetch(seen: { url?: string; body?: Record<string, unknown> }, status = 200) {
  return async (url: string, init: RequestInit): Promise<Response> => {
    seen.url = url;
    seen.body = JSON.parse(init.body as string) as Record<string, unknown>;
    return new Response(NDJSON, { status });
  };
}

async function collect(
  exec: {
    execute(r: {
      jobId: string;
      model: string;
      prompt: string;
      options?: { maxTokens?: number; think?: boolean };
    }): AsyncIterable<StreamChunk>;
  },
  options?: { maxTokens?: number; think?: boolean },
) {
  const chunks: StreamChunk[] = [];
  for await (const c of exec.execute({ jobId: "j", model: "qwen3.5:4b", prompt: "hola", options })) {
    chunks.push(c);
  }
  return chunks;
}

describe("S3 OllamaMLXAdapter", () => {
  it("mapea NDJSON a tokens separando thinking y termina con stats", async () => {
    const seen: { url?: string; body?: Record<string, unknown> } = {};
    const a = new OllamaMLXAdapter({ fetchFn: fakeFetch(seen) });
    const chunks = await collect(a);
    const think = chunks.filter((c) => c.kind === "think").map((c) => c.token).join("");
    const content = chunks.filter((c) => c.kind === "content").map((c) => c.token).join("");
    assert.equal(think, "pensando... ");
    assert.equal(content, "hola mundo");
    const last = chunks.at(-1);
    assert.equal(last?.done, true);
    assert.equal(last?.stats?.promptTokens, 9);
    assert.equal(last?.stats?.genTokens, 4);
    assert.equal(last?.stats?.prefillMs, 2);
    assert.equal(last?.stats?.decodeMs, 3);
  });

  it("pega a /api/chat nativo con modelo, stream, keep_alive=-1 y think on", async () => {
    const seen: { url?: string; body?: Record<string, unknown> } = {};
    const a = new OllamaMLXAdapter({ model: "qwen3.5:4b", fetchFn: fakeFetch(seen) });
    await collect(a);
    assert.equal(seen.url, "http://localhost:11434/api/chat");
    assert.equal(seen.body?.["model"], "qwen3.5:4b");
    assert.equal(seen.body?.["stream"], true);
    assert.equal(seen.body?.["keep_alive"], -1);
    assert.equal(seen.body?.["think"], true);
  });

  it("pasa options del request al engine (num_predict, think)", async () => {
    const seen: { url?: string; body?: Record<string, unknown> } = {};
    const a = new OllamaMLXAdapter({ fetchFn: fakeFetch(seen) });
    await collect(a, { maxTokens: 16, think: false });
    assert.equal(seen.body?.["think"], false);
    const opts = seen.body?.["options"] as Record<string, unknown>;
    assert.equal(opts["num_predict"], 16);
  });

  it("pasa tools verbatim y devuelve tool_calls en el frame done", async () => {
    const ndjson =
      `{"message":{"role":"assistant","tool_calls":[{"function":{"name":"list_forges","arguments":{}}}]}}\n` +
      `{"done":true,"eval_count":7,"eval_duration":5000000}\n`;
    const seen: { url?: string; body?: Record<string, unknown> } = {};
    const fetchFn = async (url: string, init: RequestInit): Promise<Response> => {
      seen.url = url;
      seen.body = JSON.parse(init.body as string) as Record<string, unknown>;
      return new Response(ndjson, { status: 200 });
    };
    const a = new OllamaMLXAdapter({ fetchFn });
    const tools = [{ type: "function", function: { name: "list_forges", parameters: { type: "object" } } }];
    const chunks: StreamChunk[] = [];
    for await (const c of a.execute({ jobId: "j", model: "m", prompt: "p", tools })) chunks.push(c);
    assert.deepEqual(seen.body?.["tools"], tools);
    const last = chunks.at(-1);
    assert.equal(last?.done, true);
    assert.deepEqual(last?.toolCalls, [{ name: "list_forges", arguments: {} }]);
  });

  it("S19: sirve el modelo del request, no el configurado", async () => {
    const seen: { url?: string; body?: Record<string, unknown> } = {};
    const a = new OllamaMLXAdapter({ model: "qwen3:4b", fetchFn: fakeFetch(seen) });
    await collect(a); // req.model = "qwen3.5:4b"
    assert.equal(seen.body?.["model"], "qwen3.5:4b");
  });

  it("HTTP 500 → throw con estado", async () => {
    const seen: { url?: string; body?: Record<string, unknown> } = {};
    const a = new OllamaMLXAdapter({ fetchFn: fakeFetch(seen, 500) });
    await assert.rejects(collect(a), /500/);
  });

  it("S24 probe: 200 → true, 500 → false, fetch throw → false", async () => {
    const urls: string[] = [];
    const statusFetch = (status: number) => async (url: string) => {
      urls.push(url);
      return new Response("{}", { status });
    };
    const ok = new OllamaMLXAdapter({ fetchFn: statusFetch(200) });
    assert.equal(await ok.probe(), true);
    assert.equal(urls[0], "http://localhost:11434/v1/models");
    const down = new OllamaMLXAdapter({ fetchFn: statusFetch(500) });
    assert.equal(await down.probe(), false);
    const gone = new OllamaMLXAdapter({ fetchFn: async () => { throw new Error("ECONNREFUSED"); } });
    assert.equal(await gone.probe(), false);
  });

  it("resident: /api/ps lista el modelo → true; cargado otro → false", async () => {
    const ps = (body: unknown, status = 200) => async () =>
      new Response(JSON.stringify(body), { status });
    const hot = new OllamaMLXAdapter({ fetchFn: ps({ models: [{ model: "qwen3:4b" }] }) });
    assert.equal(await hot.resident(), true);
    const cold = new OllamaMLXAdapter({ fetchFn: ps({ models: [{ model: "gemma4:e2b" }] }) });
    assert.equal(await cold.resident(), false);
    const down = new OllamaMLXAdapter({ fetchFn: ps({}, 500) });
    assert.equal(await down.resident(), false);
  });
});
