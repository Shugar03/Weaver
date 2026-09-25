// S18 — errores de input honestos: JSON roto → 400, modelo sin forge → 404,
// stream:false → JSON OpenAI, forge muerto sin-stream → 502. Jamás 500 por input.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.ts";
import { FakeForgeExec } from "@weaver/forge-exec";
import { InMemoryApiKeys } from "@weaver/api-keys";
import type { ForgeExec, StreamChunk } from "@weaver/forge-exec";

const forges = () => [
  { forgeId: "forge-hot", model: "qwen3:4b", hot: true, rttMs: 5, queueMs: 0, loadTimeMs: 0, price: 0, reliability: 1 },
];
const json = { "content-type": "application/json" };
const post = (path: string, body: string, secret?: string): [string, RequestInit] => [
  path,
  { method: "POST", headers: secret ? { ...json, authorization: `Bearer ${secret}` } : json, body },
];

describe("S18 errores de input", () => {
  it("jobs con modelo sin forge → 404 no_forge_for_model", async () => {
    const app = createApp({ forges });
    const res = await app.request(...post("/v1/jobs", JSON.stringify({ model: "llama-3.1:8b" })));
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { code: string }).code, "no_forge_for_model");
  });

  it("jobs con JSON roto → 400 bad_json", async () => {
    const app = createApp({ forges });
    const res = await app.request(...post("/v1/jobs", "{bad"));
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { code: string }).code, "bad_json");
  });

  it("chat con JSON roto → 400 bad_json", async () => {
    const app = createApp({ forges, exec: new FakeForgeExec() });
    const res = await app.request(...post("/v1/chat/completions", "{bad"));
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { code: string }).code, "bad_json");
  });

  it("admin con JSON roto → 400 bad_json (con key válida)", async () => {
    const keys = new InMemoryApiKeys();
    const op = await keys.issue("operator");
    const app = createApp({ forges, apiKeys: keys, chaos: { setDead: () => {} } });
    const res = await app.request(...post("/v1/admin/kill", "{bad", op.secret));
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { code: string }).code, "bad_json");
  });
});

describe("S18 stream:false → JSON OpenAI", () => {
  const chatBody = (stream?: boolean) =>
    JSON.stringify({ model: "qwen3:4b", messages: [{ role: "user", content: "hola" }], ...(stream === undefined ? {} : { stream }) });

  it("stream:false → chat.completion con message.content", async () => {
    const app = createApp({ forges, exec: new FakeForgeExec() });
    const res = await app.request(...post("/v1/chat/completions", chatBody(false)));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    const body = (await res.json()) as {
      object: string;
      choices: { message: { role: string; content: string }; finish_reason: string }[];
    };
    assert.equal(body.object, "chat.completion");
    assert.equal(body.choices[0].message.role, "assistant");
    assert.ok(body.choices[0].message.content.includes("echo:hola"));
    assert.equal(body.choices[0].finish_reason, "stop");
  });

  it("sin campo stream → JSON igual (default OpenAI = false)", async () => {
    const app = createApp({ forges, exec: new FakeForgeExec() });
    const res = await app.request(...post("/v1/chat/completions", chatBody()));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  });

  it("stream:true sigue siendo SSE", async () => {
    const app = createApp({ forges, exec: new FakeForgeExec() });
    const res = await app.request(...post("/v1/chat/completions", chatBody(true)));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    assert.ok((await res.text()).includes("[DONE]"));
  });

  it("forge muerto sin-stream → 502 forge_failed", async () => {
    const dead: ForgeExec = {
      forgeId: "dead",
      model: "qwen3:4b",
      async *execute(): AsyncIterable<StreamChunk> {
        throw new Error("muerto");
      },
    };
    const app = createApp({ forges, exec: dead });
    const res = await app.request(...post("/v1/chat/completions", chatBody(false)));
    assert.equal(res.status, 502);
    assert.equal(((await res.json()) as { code: string }).code, "forge_failed");
  });
});
