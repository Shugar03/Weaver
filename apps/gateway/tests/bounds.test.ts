// S-P0-3 — bounds de generación: num_ctx/max_tokens/temperature/top_p viajaban
// verbatim al engine — num_ctx: 1e9 reventaba la KV del forge por request.
// Regla: finite + entero + dentro del rango, si no → 400 bad_request.
// Y tools serializados cuentan contra el budget del prompt (60k): 48 schemas
// gigantes inflaban el contexto del engine sin contar.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.ts";
import type { ExecRequest, ForgeExec, StreamChunk } from "@weaver/forge-exec";

const forges = () => [
  { forgeId: "f1", model: "qwen3.5:4b", hot: true, rttMs: 1, queueMs: 0, loadTimeMs: 0, price: 0, reliability: 1 },
];
const json = { "content-type": "application/json" };

class SpyExec implements ForgeExec {
  readonly forgeId = "spy";
  readonly model = "qwen3.5:4b";
  last?: ExecRequest;
  async *execute(req: ExecRequest): AsyncIterable<StreamChunk> {
    this.last = req;
    yield { token: "ok", done: false };
    yield { token: "", done: true };
  }
}

const post = (extra: Record<string, unknown>): RequestInit => ({
  method: "POST",
  headers: json,
  body: JSON.stringify({ model: "qwen3.5:4b", messages: [{ role: "user", content: "hola" }], ...extra }),
});

const app = () => createApp({ forges, exec: new SpyExec() });

describe("P0-3 bounds de opciones", () => {
  for (const [field, value] of [
    ["num_ctx", 1e9], ["num_ctx", -4], ["num_ctx", 0], ["num_ctx", "abc"], ["num_ctx", 1.5],
    ["max_tokens", 1e9], ["max_tokens", -1], ["max_tokens", "muchos"],
    ["temperature", 99], ["temperature", -1], ["temperature", "alta"],
    ["top_p", 2], ["top_p", -0.5], ["top_p", "mucho"],
  ] as const) {
    it(`${field}=${JSON.stringify(value)} → 400 bad_request`, async () => {
      const res = await app().request("/v1/chat/completions", post({ [field]: value }));
      assert.equal(res.status, 400);
      assert.equal(((await res.json()) as { code: string }).code, "bad_request");
    });
  }

  it("num_ctx=65536 y max_tokens=32768 (techo) pasan; válidos llegan verbatim al engine", async () => {
    const exec = new SpyExec();
    const res = await createApp({ forges, exec }).request(
      "/v1/chat/completions",
      post({ num_ctx: 65_536, max_tokens: 32_768, temperature: 0.7, top_p: 0.9, think: false }),
    );
    assert.equal(res.status, 200);
    await res.text();
    assert.deepEqual(exec.last?.options, { maxTokens: 32768, temperature: 0.7, topP: 0.9, think: false, numCtx: 65536 });
  });

  it("num_ctx=65537 y max_tokens=32769 (sobre el techo) → 400", async () => {
    assert.equal((await app().request("/v1/chat/completions", post({ num_ctx: 65_537 }))).status, 400);
    assert.equal((await app().request("/v1/chat/completions", post({ max_tokens: 32_769 }))).status, 400);
  });
});

describe("P0-3 tools cuentan en el budget", () => {
  const tool = (n: number) => ({
    type: "function",
    function: { name: `t${n}`, description: "", parameters: { type: "object" } },
  });

  it("49 tools → 413 honesto (antes las tiraba en silencio)", async () => {
    const res = await app().request(
      "/v1/chat/completions",
      post({ tools: Array.from({ length: 49 }, (_, i) => tool(i)) }),
    );
    assert.equal(res.status, 413);
    assert.equal(((await res.json()) as { code: string }).code, "prompt_too_large");
  });

  it("messages chicos + schemas de 70k serializados → 413 (bypass cerrado)", async () => {
    const fat = { type: "function", function: { name: "fat", description: "x".repeat(70_000), parameters: {} } };
    const res = await app().request("/v1/chat/completions", post({ tools: [fat] }));
    assert.equal(res.status, 413);
  });

  it("48 tools chicas → 200 y llegan al engine", async () => {
    const exec = new SpyExec();
    const tools = Array.from({ length: 48 }, (_, i) => tool(i));
    const res = await createApp({ forges, exec }).request("/v1/chat/completions", post({ tools }));
    assert.equal(res.status, 200);
    await res.text();
    assert.equal(exec.last?.tools?.length, 48);
  });
});
