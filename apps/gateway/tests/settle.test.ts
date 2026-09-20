// S17b — cada chat OK liquida solo (fire-and-forget, jamás bloquea el stream).
// Sin settlement en Deps → sample sin settle (dev intacto).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.ts";
import { FakeForgeExec } from "@weaver/forge-exec";
import { InMemoryTelemetry } from "@weaver/telemetry";
import type { Sample } from "@weaver/telemetry";

const body = JSON.stringify({ model: "qwen3:4b", messages: [{ role: "user", content: "hola" }] });

async function chatOk(app: { request: (input: string, init?: RequestInit) => Promise<Response> | Response }) {
  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
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
    const app = createApp({ forges: () => [], exec: new FakeForgeExec(), telemetry, settlement });
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
    const app = createApp({ forges: () => [], exec: new FakeForgeExec(), telemetry, settlement });
    await chatOk(app);
    const list = await executions(app);
    assert.deepEqual(list[0].settle, { status: "failed" });
  });

  it("sin settlement → sample sin settle", async () => {
    const telemetry = new InMemoryTelemetry();
    const app = createApp({ forges: () => [], exec: new FakeForgeExec(), telemetry });
    await chatOk(app);
    const list = await executions(app);
    assert.equal(list.length, 1);
    assert.equal(list[0].settle, undefined);
  });
});
