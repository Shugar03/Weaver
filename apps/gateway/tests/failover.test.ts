// S3 — gateway sobrevive a forge muerto vía FailoverForgeExec.
// Mid-stream → evento error explícito, SIN [DONE] (nada de truncar en silencio).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.ts";
import { FailoverForgeExec } from "@weaver/forge-exec";
import type { ExecRequest, ForgeExec, StreamChunk } from "@weaver/forge-exec";

class DeadExec implements ForgeExec {
  readonly forgeId = "dead";
  readonly model = "qwen3.5:4b";
  async *execute(_req: ExecRequest): AsyncIterable<StreamChunk> {
    throw new Error("forge caído");
  }
}

class FlakyExec implements ForgeExec {
  readonly forgeId = "flaky";
  readonly model = "qwen3.5:4b";
  async *execute(_req: ExecRequest): AsyncIterable<StreamChunk> {
    yield { token: "parcial", done: false };
    throw new Error("murió a mitad");
  }
}

class OkExec implements ForgeExec {
  readonly forgeId = "ok";
  readonly model = "qwen3.5:4b";
  async *execute(_req: ExecRequest): AsyncIterable<StreamChunk> {
    yield { token: "ok-secondary", done: false };
    yield { token: "", done: true };
  }
}

const chatBody = JSON.stringify({ model: "qwen3.5:4b", messages: [{ role: "user", content: "hola" }], stream: true });

describe("S3 gateway failover", () => {
  it("forge muerto → 200 con contenido del secondary + [DONE]", async () => {
    const app = createApp({ forges: () => [], exec: new FailoverForgeExec([new DeadExec(), new OkExec()]) });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chatBody,
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes("ok-secondary"));
    assert.ok(text.includes("[DONE]"));
  });

  it("muerte mid-stream → evento error y sin [DONE]", async () => {
    const app = createApp({ forges: () => [], exec: new FailoverForgeExec([new FlakyExec(), new OkExec()]) });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chatBody,
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes("forge-failed"));
    assert.ok(!text.includes("[DONE]"));
  });
});
