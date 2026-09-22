// S17b — cada chat OK liquida solo (fire-and-forget, jamás bloquea el stream).
// Sin settlement en Deps → sample sin settle (dev intacto).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.ts";
import { FakeForgeExec } from "@weaver/forge-exec";
import { FakeVerifier } from "@weaver/settlement";
import { InMemoryTelemetry } from "@weaver/telemetry";
import type { Sample } from "@weaver/telemetry";

const body = JSON.stringify({ model: "qwen3:4b", messages: [{ role: "user", content: "hola" }] });
// S19: chat exige que el modelo exista en la fleet (404 si no).
const forges = () => [
  { forgeId: "fake-forge", model: "qwen3:4b", hot: true, rttMs: 1, queueMs: 0, loadTimeMs: 0, price: 0, reliability: 1 },
];

async function chatOk(
  app: { request: (input: string, init?: RequestInit) => Promise<Response> | Response },
  headers: Record<string, string> = {},
) {
  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
  await res.text();
}

async function executions(app: { request: (input: string, init?: RequestInit) => Promise<Response> | Response }): Promise<Sample[]> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const list = (await (await app.request("/v1/executions")).json()) as Sample[];
    if (list.length > 0 || Date.now() > deadline) return list;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("S17b settle-on-ok", () => {
  it("chat ok + settlement → sample con receipt settled", async () => {
    const telemetry = new InMemoryTelemetry();
    const settlement = {
      async settleJob() {
        return { jobId: 9, fundTx: "fund-9", releaseTx: "rel-9" };
      },
    };
    const app = createApp({ forges, exec: new FakeForgeExec(), telemetry, settlement });
    await chatOk(app);
    const list = await executions(app);
    assert.equal(list.length, 1);
    assert.deepEqual(list[0].settle, { fundTx: "fund-9", releaseTx: "rel-9", status: "settled" });
  });

  it("settlement roto → sample con failed, el chat igual fue 200", async () => {
    const telemetry = new InMemoryTelemetry();
    const settlement = {
      async settleJob(): Promise<{ jobId: number; fundTx: string; releaseTx: string }> {
        throw new Error("rpc caído");
      },
    };
    const app = createApp({ forges, exec: new FakeForgeExec(), telemetry, settlement });
    await chatOk(app);
    const list = await executions(app);
    assert.deepEqual(list[0].settle, { status: "failed" });
  });

  it("sin settlement → sample sin settle", async () => {
    const telemetry = new InMemoryTelemetry();
    const app = createApp({ forges, exec: new FakeForgeExec(), telemetry });
    await chatOk(app);
    const list = await executions(app);
    assert.equal(list.length, 1);
    assert.equal(list[0].settle, undefined);
  });

  it("S23: exec que no emite proof → settle failed, jamás invoca settleJob", async () => {
    const telemetry = new InMemoryTelemetry();
    let calls = 0;
    const settlement = {
      async settleJob() {
        calls++;
        return { jobId: 1, fundTx: "f", releaseTx: "r" };
      },
    };
    // Un forge que sirve tokens pero no firma: el contrato no verificaría.
    class UnprovenExec {
      readonly forgeId = "fake-forge";
      readonly model = "qwen3:4b";
      async *execute() {
        yield { token: "ok", done: false };
        yield { token: "", done: true };
      }
    }
    const app = createApp({ forges, exec: new UnprovenExec(), telemetry, settlement });
    await chatOk(app);
    const list = await executions(app);
    assert.equal(calls, 0);
    assert.deepEqual(list[0].settle, { status: "failed" });
  });
});

describe("S21 Idempotency-Key", () => {
  it("mismo key en 2 chats → re-ejecuta pero un solo settle on-chain", async () => {
    const telemetry = new InMemoryTelemetry();
    let calls = 0;
    const settlement = {
      async settleJob() {
        calls++;
        return { jobId: calls, fundTx: `f${calls}`, releaseTx: `r${calls}` };
      },
    };
    const app = createApp({ forges, exec: new FakeForgeExec(), telemetry, settlement });
    const key = { "idempotency-key": "k-1" };
    await chatOk(app, key);
    await chatOk(app, key);
    const list = await executions(app);
    assert.equal(list.length, 2); // el retry sirvió de verdad
    assert.equal(calls, 1); // pero el cobro no se duplicó
  });

  it("keys distintas → dos settles; sin key → cada chat settlea", async () => {
    const telemetry = new InMemoryTelemetry();
    let calls = 0;
    const settlement = {
      async settleJob() {
        calls++;
        return { jobId: calls, fundTx: "f", releaseTx: "r" };
      },
    };
    const app = createApp({ forges, exec: new FakeForgeExec(), telemetry, settlement });
    await chatOk(app, { "idempotency-key": "a" });
    await chatOk(app, { "idempotency-key": "b" });
    await chatOk(app);
    await executions(app);
    assert.equal(calls, 3);
  });
});

describe("S23 x402 settle post-serve", () => {
  it("chat pagado → sample con payerTx del settle del cliente", async () => {
    const telemetry = new InMemoryTelemetry();
    const app = createApp({
      forges,
      exec: new FakeForgeExec(),
      telemetry,
      paywall: { verifier: new FakeVerifier(), payTo: "GOPERATOR" },
    });
    await chatOk(app, { "x-payment": "valid-proof" });
    const list = await executions(app);
    assert.equal(list.length, 1);
    assert.equal(list[0].settle?.payerTx, "fake-client-tx");
    assert.equal(list[0].settle?.status, "settled");
  });

  it("chat pagado + escrow → las dos patas: payerTx y fundTx/releaseTx", async () => {
    const telemetry = new InMemoryTelemetry();
    const settlement = {
      async settleJob() {
        return { jobId: 3, fundTx: "fund-x", releaseTx: "rel-x" };
      },
    };
    const app = createApp({
      forges,
      exec: new FakeForgeExec(),
      telemetry,
      settlement,
      paywall: { verifier: new FakeVerifier(), payTo: "GOPERATOR" },
    });
    await chatOk(app, { "x-payment": "valid-proof" });
    const list = await executions(app);
    assert.deepEqual(list[0].settle, {
      payerTx: "fake-client-tx",
      fundTx: "fund-x",
      releaseTx: "rel-x",
      status: "settled",
    });
  });
});
