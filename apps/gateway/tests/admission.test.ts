// S29 — admission control: todos los forges vivos del modelo saturados → 429
// honesto antes de abrir stream (un request encolado eterno miente al cliente).
// Muertos/breaker-open no cuentan como "vivos": sin ellos, el failover decide.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.ts";
import { RoutedExec, type ExecRequest, type ForgeExec, type StreamChunk } from "@weaver/forge-exec";
import type { ForgeView } from "@weaver/scheduler";

class OkExec implements ForgeExec {
  readonly forgeId: string;
  readonly model = "qwen3:4b";
  constructor(forgeId: string) {
    this.forgeId = forgeId;
  }
  async *execute(_req: ExecRequest): AsyncIterable<StreamChunk> {
    yield { token: "ok", done: false };
    yield { token: "", done: true };
  }
}

const view = (forgeId: string, over: Partial<ForgeView> = {}): ForgeView => ({
  forgeId,
  model: "qwen3:4b",
  hot: true,
  rttMs: 5,
  queueMs: 0,
  loadTimeMs: 0,
  price: 0,
  reliability: 1,
  ...over,
});

const appOf = (views: ForgeView[]) =>
  createApp({
    exec: new RoutedExec<ForgeView>({
      forges: async () => views,
      execs: { a: new OkExec("a"), b: new OkExec("b") },
      order: (_req, vs) => vs,
    }),
    forges: async () => views,
  });

const chat = async (app: ReturnType<typeof createApp>) => {
  const r = await app.request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "qwen3:4b", messages: [{ role: "user", content: "hola" }] }),
  });
  return { status: r.status, body: await r.text() };
};

describe("S29 admission control", () => {
  it("todos saturados → 429 busy (no stream colgado)", async () => {
    const app = appOf([view("a", { saturated: true, inFlight: 4 }), view("b", { saturated: true, inFlight: 4 })]);
    const res = await chat(app);
    assert.equal(res.status, 429);
    assert.match(res.body, /busy/);
  });

  it("uno saturado, otro libre → sirve el libre (200)", async () => {
    const app = appOf([view("a", { saturated: true, inFlight: 4 }), view("b", { inFlight: 1 })]);
    assert.equal((await chat(app)).status, 200);
  });

  it("saturado no cuenta si está muerto: vivos saturados + muerto → 429", async () => {
    const app = appOf([
      view("a", { saturated: true, queueMs: 99_999 }), // muerto: no es "vivo saturado"
      view("b", { saturated: true, inFlight: 4 }),
    ]);
    assert.equal((await chat(app)).status, 429);
  });

  it("sin saturación → flujo normal (200)", async () => {
    const app = appOf([view("a", { inFlight: 3 }), view("b")]);
    assert.equal((await chat(app)).status, 200);
  });
});
