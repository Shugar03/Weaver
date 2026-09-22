// S37 — verificación de proof por-job para forges remotos.
// Un remoto que firma basura: jamás settlea, va al breaker, aunque el stream
// al cliente haya sido 200 (el daño ya está hecho — la defensa es no pagarlo
// y sacarlo de routing). Embedded (sin pubkey en registry) no pasa por acá.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.ts";
import { FakeForgeExec } from "@weaver/forge-exec";
import { InMemoryTelemetry } from "@weaver/telemetry";
import type { Sample } from "@weaver/telemetry";

const body = JSON.stringify({ model: "qwen3:4b", messages: [{ role: "user", content: "hola" }] });
const forges = () => [
  { forgeId: "fake-forge", model: "qwen3:4b", hot: true, rttMs: 1, queueMs: 0, loadTimeMs: 0, price: 0, reliability: 1 },
];

async function chatOk(app: { request: (i: string, init?: RequestInit) => Promise<Response> | Response }) {
  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  await res.text();
  return res.status;
}

async function executions(app: { request: (i: string, init?: RequestInit) => Promise<Response> | Response }): Promise<Sample[]> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const list = (await (await app.request("/v1/executions")).json()) as Sample[];
    if (list.length > 0 || Date.now() > deadline) return list;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("S37 verificación de proof remoto por-job", () => {
  it("firma inválida → no settlea + breaker.fail + sample failed", async () => {
    const telemetry = new InMemoryTelemetry();
    let settleCalls = 0;
    const failed: string[] = [];
    const app = createApp({
      forges,
      exec: new FakeForgeExec(),
      telemetry,
      settlement: { async settleJob() { settleCalls++; return { jobId: 1, fundTx: "f", releaseTx: "r" }; } },
      forgePubkeyOf: (id) => (id === "fake-forge" ? "GPUBKEY" : undefined),
      verifyProof: () => false, // firma basura
      breaker: { fail: (id: string) => { failed.push(id); }, ok: () => {} },
    });
    assert.equal(await chatOk(app), 200); // el cliente recibió su stream
    const list = await executions(app);
    assert.equal(settleCalls, 0);
    assert.deepEqual(failed, ["fake-forge"]);
    assert.deepEqual(list[0].settle, { status: "failed" });
  });

  it("firma válida → settleJob con el worker del registry", async () => {
    const telemetry = new InMemoryTelemetry();
    const seen: { hash?: Buffer; worker?: string } = {};
    const app = createApp({
      forges,
      exec: new FakeForgeExec(),
      telemetry,
      settlement: {
        async settleJob(hash: Buffer, _sig: Buffer, worker?: string) {
          seen.hash = hash;
          seen.worker = worker;
          return { jobId: 1, fundTx: "f", releaseTx: "r" };
        },
      },
      forgePubkeyOf: () => "GPUBKEY",
      verifyProof: (pub: string, hash: Buffer, sig: Buffer) =>
        pub === "GPUBKEY" && hash.length === 32 && sig.length === 64,
    });
    assert.equal(await chatOk(app), 200);
    await executions(app);
    assert.equal(seen.worker, "GPUBKEY");
    assert.equal(seen.hash?.length, 32);
  });

  it("sin settlement configurado, la verificación corre igual (breaker)", async () => {
    const telemetry = new InMemoryTelemetry();
    const failed: string[] = [];
    const app = createApp({
      forges,
      exec: new FakeForgeExec(),
      telemetry,
      forgePubkeyOf: () => "GPUBKEY",
      verifyProof: () => false,
      breaker: { fail: (id: string) => { failed.push(id); }, ok: () => {} },
    });
    await chatOk(app);
    const list = await executions(app);
    assert.deepEqual(failed, ["fake-forge"]);
    assert.deepEqual(list[0].settle, { status: "failed" });
  });

  it("forge embedded (sin pubkey en registry) → salta verify, settlea normal", async () => {
    const telemetry = new InMemoryTelemetry();
    let settleCalls = 0;
    let verifyCalls = 0;
    const app = createApp({
      forges,
      exec: new FakeForgeExec(),
      telemetry,
      settlement: { async settleJob() { settleCalls++; return { jobId: 1, fundTx: "f", releaseTx: "r" }; } },
      forgePubkeyOf: () => undefined, // embedded — no es remoto
      verifyProof: () => { verifyCalls++; return false; },
    });
    await chatOk(app);
    const list = await executions(app);
    assert.equal(verifyCalls, 0);
    assert.equal(settleCalls, 1);
    assert.equal(list[0].settle?.status, "settled");
  });
});

describe("S38 audit callback post-job", () => {
  it("job OK de remoto → audit(forgeId, model) dispara fire-and-forget", async () => {
    const telemetry = new InMemoryTelemetry();
    const audited: string[] = [];
    const app = createApp({
      forges,
      exec: new FakeForgeExec(),
      telemetry,
      forgePubkeyOf: () => "GPUBKEY",
      verifyProof: () => true,
      audit: (forgeId: string, model: string) => { audited.push(`${forgeId}:${model}`); },
    });
    await chatOk(app);
    await executions(app);
    assert.deepEqual(audited, ["fake-forge:qwen3:4b"]);
  });

  it("embedded (sin pubkey) → no se audita", async () => {
    const telemetry = new InMemoryTelemetry();
    const audited: string[] = [];
    const app = createApp({
      forges,
      exec: new FakeForgeExec(),
      telemetry,
      forgePubkeyOf: () => undefined,
      audit: (forgeId: string) => { audited.push(forgeId); },
    });
    await chatOk(app);
    await executions(app);
    assert.equal(audited.length, 0);
  });
});
