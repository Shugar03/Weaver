// S3/S45 — gateway sobrevive a forge muerto vía FailoverForgeExec.
// Pre-token → salta al siguiente. Mid-stream → el siguiente RESUME desde el
// prefijo ya emitido (frame weaver_route con resumedPrefixLen). Sin sucesor
// vivo → evento error explícito, SIN [DONE] (nada de truncar en silencio).
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
// S19: chat exige que el modelo exista en la fleet.
const forges = () => [
  { forgeId: "dead", model: "qwen3.5:4b", hot: true, rttMs: 1, queueMs: 0, loadTimeMs: 0, price: 0, reliability: 1 },
  { forgeId: "ok", model: "qwen3.5:4b", hot: true, rttMs: 2, queueMs: 0, loadTimeMs: 0, price: 0, reliability: 1 },
];

describe("S3 gateway failover", () => {
  it("forge muerto → 200 con contenido del secondary + [DONE]", async () => {
    const app = createApp({ forges, exec: new FailoverForgeExec([new DeadExec(), new OkExec()]) });
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

  it("muerte mid-stream → el sucesor RESUME el stream (prefijo + weaver_route)", async () => {
    const app = createApp({ forges, exec: new FailoverForgeExec([new FlakyExec(), new OkExec()]) });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chatBody,
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    // El stream sobrevive: prefijo del muerto + sufijo del que retomó + DONE.
    assert.ok(text.includes("parcial"), "el prefijo del forge muerto sigue servido");
    assert.ok(text.includes("ok-secondary"), "el sucesor continuó el stream");
    assert.ok(text.includes("[DONE]"), "el stream cierra completo tras resume");
    // Frame meta mid-stream: resumedPrefixLen marca el boundary del sufijo firmado.
    const route = text.match(/data: (\{"weaver_route":[^\n]*\})/);
    assert.ok(route, "falta el frame weaver_route del resume");
    const j = JSON.parse(route![1]) as { weaver_route: { failed: string[]; serving: string; resumedPrefixLen?: number } };
    assert.deepEqual(j.weaver_route.failed, ["flaky"]);
    assert.equal(j.weaver_route.serving, "ok");
    assert.equal(j.weaver_route.resumedPrefixLen, "parcial".length);
  });

  it("muerte mid-stream SIN sucesor → evento error y sin [DONE]", async () => {
    const app = createApp({ forges: () => [forges()[0]], exec: new FailoverForgeExec([new FlakyExec()]) });
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
