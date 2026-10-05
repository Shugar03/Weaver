// P1 — polish adversarial: idempotency-key sin bound inflaba la key del
// settleCache; /v1/images/generations con JSON roto → 500 pelado; y la
// creación de cuentas es abierta por producto pero no infinita por IP.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.ts";
import { InMemoryAccountStore, InMemoryCreditLedger, PricingBook } from "@weaver/accounts";
import { InMemoryApiKeys } from "@weaver/api-keys";
import type { ExecRequest, ForgeExec, StreamChunk } from "@weaver/forge-exec";

const forges = () => [
  { forgeId: "f1", model: "qwen3.5:4b", hot: true, rttMs: 1, queueMs: 0, loadTimeMs: 0, price: 0, reliability: 1 },
];
const json = { "content-type": "application/json" };

class QuietExec implements ForgeExec {
  readonly forgeId = "q";
  readonly model = "qwen3.5:4b";
  calls = 0;
  async *execute(_req: ExecRequest): AsyncIterable<StreamChunk> {
    this.calls++;
    yield { token: "ok", done: false };
    yield { token: "", done: true };
  }
}

const chat = (extraHeaders: Record<string, string> = {}) => ({
  method: "POST" as const,
  headers: { ...json, ...extraHeaders },
  body: JSON.stringify({ model: "qwen3.5:4b", messages: [{ role: "user", content: "hola" }] }),
});

describe("P1 polish", () => {
  it("idempotency-key >128 chars → 400 (la key indexa el settleCache)", async () => {
    const exec = new QuietExec();
    const app = createApp({ forges, exec });
    const res = await app.request("/v1/chat/completions", chat({ "idempotency-key": "x".repeat(200) }));
    assert.equal(res.status, 400);
    assert.equal(exec.calls, 0); // rechazado ANTES de tocar el forge
    const ok = await app.request("/v1/chat/completions", chat({ "idempotency-key": "uuid-normal-123" }));
    assert.equal(ok.status, 200);
    await ok.text();
  });

  it("POST /v1/images/generations con JSON roto → 400 bad_json (no 500)", async () => {
    const app = createApp({ forges, imageExecs: {} });
    const res = await app.request("/v1/images/generations", { method: "POST", headers: json, body: "{roto" });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { code: string }).code, "bad_json");
  });

  it("POST /v1/accounts: abierto pero no infinito — >10/min/IP → 429", async () => {
    const app = createApp({
      forges,
      apiKeys: new InMemoryApiKeys(),
      accounts: new InMemoryAccountStore(),
      ledger: new InMemoryCreditLedger(),
      pricing: new PricingBook({ "qwen3.5:4b": { prompt: 1n, completion: 1n, image: 0n } }),
    });
    for (let i = 0; i < 10; i++) {
      assert.equal((await app.request("/v1/accounts", { method: "POST" })).status, 201, `alta #${i}`);
    }
    assert.equal((await app.request("/v1/accounts", { method: "POST" })).status, 429);
  });
});
