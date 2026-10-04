// spec 014 — weaver_route: el failover se reporta al cliente (SSE + JSON).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.ts";
import { FailoverForgeExec } from "@weaver/forge-exec";
import type { ExecRequest, ForgeExec, StreamChunk } from "@weaver/forge-exec";

class DeadExec implements ForgeExec {
  readonly forgeId = "live1";
  readonly model = "qwen3:4b";
  async *execute(_req: ExecRequest): AsyncIterable<StreamChunk> {
    throw new Error("forge caído");
  }
}
class OkExec implements ForgeExec {
  readonly forgeId = "live2";
  readonly model = "qwen3:4b";
  async *execute(_req: ExecRequest): AsyncIterable<StreamChunk> {
    yield { token: "hola", done: false };
    yield { token: "", done: true };
  }
}

const forges = () => [
  { forgeId: "live1", model: "qwen3:4b", hot: true, rttMs: 1, queueMs: 0, loadTimeMs: 0, price: 0, reliability: 1 },
  { forgeId: "live2", model: "qwen3:4b", hot: true, rttMs: 2, queueMs: 0, loadTimeMs: 0, price: 0, reliability: 1 },
];
const body = (stream: boolean) =>
  JSON.stringify({ model: "qwen3:4b", messages: [{ role: "user", content: "hola" }], stream });

describe("spec 014 — route visibility", () => {
  it("SSE: failover pre-token → frame weaver_route {failed, serving} antes del contenido", async () => {
    const app = createApp({ forges, exec: new FailoverForgeExec([new DeadExec(), new OkExec()]) });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body(true),
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    const route = text.match(/data: (\{"weaver_route":.*\})/);
    assert.ok(route, "no hay frame weaver_route");
    const j = JSON.parse(route![1]) as { weaver_route: { failed: string[]; serving: string } };
    assert.deepEqual(j.weaver_route.failed, ["live1"]);
    assert.equal(j.weaver_route.serving, "live2");
    // llega ANTES del primer token de contenido
    assert.ok(text.indexOf("weaver_route") < text.indexOf("hola"));
  });

  it("SSE: sin failover → sin frame weaver_route", async () => {
    const app = createApp({ forges, exec: new FailoverForgeExec([new OkExec()]) });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body(true),
    });
    const text = await res.text();
    assert.ok(!text.includes("weaver_route"));
  });

  it("JSON non-stream: weaver_route top-level cuando hubo intentos", async () => {
    const app = createApp({ forges, exec: new FailoverForgeExec([new DeadExec(), new OkExec()]) });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body(false),
    });
    assert.equal(res.status, 200);
    const j = (await res.json()) as { weaver_route?: { failed: string[]; serving: string } };
    assert.deepEqual(j.weaver_route?.failed, ["live1"]);
    assert.equal(j.weaver_route?.serving, "live2");
  });
});
