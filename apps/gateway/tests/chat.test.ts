// S2 — POST /v1/chat/completions SSE con FakeForgeExec (verdadero rojo).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.ts";
import { FakeForgeExec } from "@weaver/forge-exec";

describe("S2 SSE completions", () => {
  it("streamea chunks OpenAI-compatibles y cierra con [DONE]", async () => {
    const app = createApp({ forges: () => [], exec: new FakeForgeExec() });
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
