// Adversarial: forge deshonesto o mal configurado. El trust layer ES el
// producto (Track 04) — cada vector debe fallar CERRADO: output ya salió al
// cliente, pero jamás se paga y el forge va al breaker. Cubre los casos que
// evmloop no: chain confundida, pubkey malformada, firma de otro payload,
// proof vacía, verifier que explota, y el feedback ERC-8004 fallando.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.ts";
import { FakeForgeExec, ProvenForgeExec } from "@weaver/forge-exec";
import { dualVerify, evmForgeKeypair, stellarKeypair } from "@weaver/settlement";
import { InMemoryTelemetry } from "@weaver/telemetry";
import type { Sample } from "@weaver/telemetry";
import type { Hex } from "viem";

const EVM_A = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const body = JSON.stringify({ model: "qwen3:4b", messages: [{ role: "user", content: "hola" }] });
const forges = () => [
  { forgeId: "forge-a", model: "qwen3:4b", hot: true, rttMs: 1, queueMs: 0, loadTimeMs: 0, price: 0, reliability: 1 },
];

type App = { request: (i: string, init?: RequestInit) => Promise<Response> | Response };

async function run(app: App) {
  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  await res.text();
  const deadline = Date.now() + 3000;
  let list: Sample[] = [];
  while (list.length === 0 && Date.now() < deadline) {
    list = (await (await app.request("/v1/executions")).json()) as Sample[];
    if (list.length === 0) await new Promise((r) => setTimeout(r, 25));
  }
  return { status: res.status, exec: list[0] };
}

// Harness: pubkey declarada + signer arbitrario + deps extra → corre un chat.
function rig(pubkey: string | undefined, sign: (m: Buffer) => Buffer | Promise<Buffer>, extra: Record<string, unknown> = {}) {
  const settleCalls: { worker?: string }[] = [];
  const failed: string[] = [];
  const telemetry = new InMemoryTelemetry();
  const app = createApp({
    forges,
    exec: new ProvenForgeExec(new FakeForgeExec({ forgeId: "forge-a" }), sign),
    telemetry,
    settlement: {
      async settleJob(_h: Buffer, _s: Buffer, worker?: string) {
        settleCalls.push({ worker });
        return { jobId: 1, fundTx: "f", releaseTx: "r" };
      },
    },
    forgePubkeyOf: () => pubkey,
    verifyProof: dualVerify,
    breaker: { fail: (id: string) => failed.push(id), ok: () => {} },
    ...extra,
  });
  return { app, settleCalls, failed };
}

describe("adversarial forge — fail-closed por vector", () => {
  it("pubkey EVM pero firma stellar (chain confundida) → no paga + breaker", async () => {
    const evm = evmForgeKeypair(EVM_A);
    const stellar = stellarKeypair();
    // El forge produce sig ed25519 (64b) pero declara address 0x — ecrecover
    // no puede recuperar → false.
    const { app, settleCalls, failed } = rig(evm.address, stellar.sign);
    assert.equal((await run(app)).status, 200);
    assert.equal(settleCalls.length, 0);
    assert.deepEqual(failed, ["forge-a"]);
  });

  it("pubkey malformada ('0xZZZ') → scheme null → no paga + breaker", async () => {
    const evm = evmForgeKeypair(EVM_A);
    const { app, settleCalls, failed } = rig("0xZZZ", evm.sign);
    await run(app);
    assert.equal(settleCalls.length, 0);
    assert.deepEqual(failed, ["forge-a"]);
  });

  it("firma un hash distinto al que sirvió → verify false → no paga + breaker", async () => {
    const evm = evmForgeKeypair(EVM_A);
    // El signer ignora el hash real y firma basura — sig válida, msg equivocado.
    const { app, settleCalls, failed } = rig(evm.address, () => evm.sign(Buffer.alloc(32, 0x99)));
    await run(app);
    assert.equal(settleCalls.length, 0);
    assert.deepEqual(failed, ["forge-a"]);
  });

  it("proof con firma vacía → no paga + breaker", async () => {
    const evm = evmForgeKeypair(EVM_A);
    const { app, settleCalls, failed } = rig(evm.address, () => Buffer.alloc(0));
    await run(app);
    assert.equal(settleCalls.length, 0);
    assert.deepEqual(failed, ["forge-a"]);
  });

  it("verifyProof que explota (throw sync) → catch → no paga + breaker", async () => {
    const evm = evmForgeKeypair(EVM_A);
    const { app, settleCalls, failed } = rig(evm.address, evm.sign, {
      verifyProof: () => {
        throw new Error("verifier crasheado");
      },
    });
    await run(app);
    assert.equal(settleCalls.length, 0);
    assert.deepEqual(failed, ["forge-a"]);
  });

  it("fleet mixta: forge stellar por dualVerify → verify OK → settlea", async () => {
    const stellar = stellarKeypair();
    const { app, settleCalls, failed } = rig(stellar.pubkey, stellar.sign);
    const r = await run(app);
    assert.equal(r.status, 200);
    assert.equal(settleCalls.length, 1);
    assert.equal(settleCalls[0].worker, stellar.pubkey);
    assert.equal(failed.length, 0);
    assert.equal(r.exec?.settle?.status, "settled");
  });

  it("onSettled que falla (feedback ERC-8004 caído) → el settle igual queda", async () => {
    const evm = evmForgeKeypair(EVM_A);
    const { app, settleCalls } = rig(evm.address, evm.sign, {
      onSettled: () => {
        throw new Error("erc-8004 registry caído");
      },
    });
    const r = await run(app);
    assert.equal(settleCalls.length, 1);
    assert.equal(r.exec?.settle?.status, "settled", "feedback caído no puede romper el pago");
  });
});
