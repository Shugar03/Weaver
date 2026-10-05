// OpenAICompatAdapter — el dialecto SSE /v1/chat/completions de vLLM,
// llama.cpp-server y afines. Cada hecho se verifica contra un fetch fake:
// frames data: con reasoning_content (think), tool_calls por delta indexado,
// usage medido del engine y resume mid-stream como assistant-prefix.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OpenAICompatAdapter } from "../src/openaicompat.ts";
import type { ExecRequest, StreamChunk } from "../src/ports.ts";

const sse = (frames: (object | "DONE")[]): Response => {
  const body = frames.map((f) => `data: ${f === "DONE" ? "[DONE]" : JSON.stringify(f)}\n\n`).join("");
  return new Response(new TextEncoder().encode(body), { status: 200 });
};

const collect = async (a: OpenAICompatAdapter, req?: Partial<ExecRequest>) => {
  const chunks: StreamChunk[] = [];
  for await (const c of a.execute({ jobId: "j", model: "big-model", prompt: "hola", ...req })) chunks.push(c);
  return chunks;
};

describe("OpenAICompatAdapter (vLLM/llama.cpp-server)", () => {
  it("parsea SSE: content + reasoning_content → kind think, usage medido", async () => {
    const a = new OpenAICompatAdapter({
      model: "big-model",
      fetchFn: async () =>
        sse([
          { choices: [{ delta: { role: "assistant" } }] },
          { choices: [{ delta: { reasoning_content: "pensando " } }] },
          { choices: [{ delta: { reasoning_content: "fuerte" } }] },
          { choices: [{ delta: { content: "respuesta " } }] },
          { choices: [{ delta: { content: "grande" } }] },
          { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 42, completion_tokens: 7 } },
          "DONE",
        ]),
    });
    const chunks = await collect(a);
    assert.equal(chunks[0].token, "pensando ");
    assert.equal(chunks[0].kind, "think");
    const text = chunks.filter((c) => c.kind === "content").map((c) => c.token).join("");
    assert.equal(text, "respuesta grande");
    const done = chunks.at(-1)!;
    assert.ok(done.done);
    assert.equal(done.stats?.promptTokens, 42);
    assert.equal(done.stats?.genTokens, 7);
  });

  it("variante `reasoning` (OpenRouter) también mapea a kind think", async () => {
    const a = new OpenAICompatAdapter({
      model: "big-model",
      fetchFn: async () =>
        sse([
          { choices: [{ delta: { reasoning: "piensa" } }] },
          { choices: [{ delta: { content: "ok" } }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
          "DONE",
        ]),
    });
    const chunks = await collect(a);
    assert.equal(chunks[0].kind, "think");
    assert.equal(chunks[0].token, "piensa");
    assert.equal(chunks[1].kind, "content");
  });

  it("frame SSE partido a mitad de línea → el buffer recompone antes de parsear", async () => {
    // TCP corta donde quiere: un JSON puede llegar en 2 reads. El parser
    // acumula por \n — un frame truncado NO debe romper ni perder tokens.
    const full = `data: ${JSON.stringify({ choices: [{ delta: { content: "partido" } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
    const bytes = new TextEncoder().encode(full);
    const half = bytes.length >> 1;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, half));
        c.enqueue(bytes.slice(half));
        c.close();
      },
    });
    const a = new OpenAICompatAdapter({ model: "m", fetchFn: async () => new Response(stream, { status: 200 }) });
    const chunks = await collect(a);
    assert.equal(chunks[0].token, "partido");
    assert.ok(chunks.at(-1)!.done);
  });

  it("tool_calls llegan por delta indexado → completos en done", async () => {
    const a = new OpenAICompatAdapter({
      model: "big-model",
      fetchFn: async () =>
        sse([
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "web_search", arguments: "" } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":"mo' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'nad"}' } }] } }] },
          { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
          "DONE",
        ]),
    });
    const chunks = await collect(a);
    const done = chunks.at(-1)!;
    assert.deepEqual(done.toolCalls, [{ name: "web_search", arguments: { q: "monad" } }]);
  });

  it("resume mid-stream → append assistant-prefix a los messages enviados", async () => {
    let sent: { messages?: { role: string; content: string }[] } = {};
    const a = new OpenAICompatAdapter({
      model: "big-model",
      fetchFn: async (_url, init) => {
        sent = JSON.parse(String(init.body)) as typeof sent;
        return sse([{ choices: [{ delta: { content: "sufijo" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }, "DONE"]);
      },
    });
    await collect(a, {
      messages: [{ role: "user", content: "escribí un poema" }],
      resume: { prefix: "las rosas son" },
    });
    assert.deepEqual(sent.messages, [
      { role: "user", content: "escribí un poema" },
      { role: "assistant", content: "las rosas son" },
    ]);
  });

  it("stream_options pide usage — tokens siempre medidos, nunca estimados", async () => {
    let sentBody = "";
    const a = new OpenAICompatAdapter({
      model: "big-model",
      fetchFn: async (_url, init) => {
        sentBody = String(init.body);
        return sse([{ choices: [{ delta: { content: "x" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }, "DONE"]);
      },
    });
    await collect(a);
    assert.ok(sentBody.includes('"include_usage":true'));
  });

  it("engine caído (fetch rechaza / http !ok) → error, no stream vacío", async () => {
    const down = new OpenAICompatAdapter({ model: "m", fetchFn: async () => { throw new Error("ECONNREFUSED"); } });
    await assert.rejects(collect(down), /ECONNREFUSED/);
    const bad = new OpenAICompatAdapter({ model: "m", fetchFn: async () => new Response("nope", { status: 500 }) });
    await assert.rejects(collect(bad), /http 500/);
  });

  it("probe/resident honestos contra /v1/models", async () => {
    const a = new OpenAICompatAdapter({
      model: "big-model",
      fetchFn: async (url) =>
        url.endsWith("/v1/models")
          ? new Response(JSON.stringify({ data: [{ id: "big-model" }] }), { status: 200 })
          : sse(["DONE"]),
    });
    assert.equal(await a.probe(), true);
    assert.equal(await a.resident(), true);
    const other = new OpenAICompatAdapter({
      model: "not-loaded",
      fetchFn: async (url) =>
        url.endsWith("/v1/models")
          ? new Response(JSON.stringify({ data: [{ id: "big-model" }] }), { status: 200 })
          : sse(["DONE"]),
    });
    assert.equal(await other.resident(), false); // modelo no cargado ≠ residente
  });
});
