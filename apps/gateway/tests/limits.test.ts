// S11 — caps de input: prompt gigante o spam de mensajes → 413, nunca OOM de Ollama.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.ts";
import { FakeForgeExec } from "@weaver/forge-exec";

const chat = (messages: { role: string; content: string }[]) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "qwen3:4b", messages, stream: true }),
});

describe("S11 límites de input", () => {
  it("prompt >8000 chars → 413 prompt_too_large", async () => {
    const app = createApp({ forges: () => [], exec: new FakeForgeExec() });
    const res = await app.request("/v1/chat/completions", chat([{ role: "user", content: "x".repeat(8001) }]));
    assert.equal(res.status, 413);
    assert.equal(((await res.json()) as { code: string }).code, "prompt_too_large");
  });

  it("21 mensajes → 413", async () => {
    const app = createApp({ forges: () => [], exec: new FakeForgeExec() });
    const msgs = Array.from({ length: 21 }, (_, i) => ({ role: "user", content: `m${i}` }));
    const res = await app.request("/v1/chat/completions", chat(msgs));
    assert.equal(res.status, 413);
  });

  it("normal → 200", async () => {
    const app = createApp({ forges: () => [], exec: new FakeForgeExec() });
    const res = await app.request("/v1/chat/completions", chat([{ role: "user", content: "hola" }]));
    assert.equal(res.status, 200);
  });
});
