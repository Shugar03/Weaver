// S27 — circuit breaker end-to-end: un forge que falla exec repetidamente
// (pero cuyo probe diría vivo) queda marcado no-disponible en /v1/forges.
// Sin breaker, cada request pagaba un intento fallido antes del failover.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.ts";
import { RoutedExec, type ExecRequest, type ForgeExec, type StreamChunk } from "@weaver/forge-exec";
import { applyBreaker, CircuitBreaker, type ForgeView } from "@weaver/scheduler";

class FlakyExec implements ForgeExec {
  readonly forgeId = "flaky";
  readonly model = "qwen3:4b";
  async *execute(_req: ExecRequest): AsyncIterable<StreamChunk> {
    throw new Error("forge roto");
  }
}
class OkExec implements ForgeExec {
  readonly forgeId = "ok";
  readonly model = "qwen3:4b";
  async *execute(_req: ExecRequest): AsyncIterable<StreamChunk> {
    yield { token: "ok", done: false };
    yield { token: "", done: true };
  }
}

const VIEWS: ForgeView[] = [
  // el malo tiene mejor ETR → se intenta primero en cada request
  { forgeId: "flaky", model: "qwen3:4b", hot: true, rttMs: 1, queueMs: 0, loadTimeMs: 0, price: 0, reliability: 1 },
  { forgeId: "ok", model: "qwen3:4b", hot: true, rttMs: 50, queueMs: 0, loadTimeMs: 0, price: 0, reliability: 1 },
];

async function chat(app: ReturnType<typeof createApp>) {
  const res = await app.request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "qwen3:4b", messages: [{ role: "user", content: "hola" }] }),
  });
  await res.text(); // drenar el stream completo
  return res.status;
}

describe("S27 breaker", () => {
  it("3 fallos consecutivos → el forge queda no-disponible en /v1/forges", async () => {
    const breaker = new CircuitBreaker();
    const exec = new RoutedExec<ForgeView>({
      forges: async () => VIEWS,
      execs: { flaky: new FlakyExec(), ok: new OkExec() },
      order: (_req, views) => views,
    });
    const app = createApp({
      exec,
      forges: async () => applyBreaker([...VIEWS], breaker),
      breaker,
    });
    // 3 requests: flaky falla pre-token cada vez, ok sirve (failover lo absorbe)
    for (let i = 0; i < 3; i++) assert.equal(await chat(app), 200);
    const forges = (await (await app.request("http://localhost/v1/forges")).json()) as ForgeView[];
    const flaky = forges.find((f) => f.forgeId === "flaky");
    assert.equal(flaky?.queueMs, 99_999); // marcado no-disponible
    assert.equal(forges.find((f) => f.forgeId === "ok")?.queueMs, 0);
  });
});
