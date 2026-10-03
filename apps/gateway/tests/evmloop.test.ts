// Loop EVM end-to-end en proceso: ProvenForgeExec firma el result hash con una
// key secp256k1 real → el gateway verifica con ecrecover (viem) → settleJob
// recibe worker=address + firma de 65 bytes → onSettled arma el feedback
// ERC-8004 con evidencia del settle. Fail-closed: una firma de otra key no
// settlea y va al breaker — idéntico al path Stellar, crypto real de por medio.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.ts";
import { FakeForgeExec, ProvenForgeExec } from "@weaver/forge-exec";
import { evmForgeKeypair, evmVerify, jobSettledFeedback } from "@weaver/settlement";
import { InMemoryTelemetry } from "@weaver/telemetry";
import type { Sample } from "@weaver/telemetry";
import type { Address, Hex } from "viem";

const FORGE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const OTHER_KEY = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e87293ed2b02a" as Hex;

const body = JSON.stringify({ model: "qwen3:4b", messages: [{ role: "user", content: "hola" }] });
const forges = () => [
  { forgeId: "evm-forge", model: "qwen3:4b", hot: true, rttMs: 1, queueMs: 0, loadTimeMs: 0, price: 0, reliability: 1 },
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

describe("loop EVM: proof secp256k1 → ecrecover → settle → feedback ERC-8004", () => {
  it("firma válida → verify ecrecover OK, settlea con worker=address, feedback armado", async () => {
    const forge = evmForgeKeypair(FORGE_KEY);
    const telemetry = new InMemoryTelemetry();
    const seen: { hash?: Buffer; sig?: Buffer; worker?: string } = {};
    let feedback: ReturnType<typeof jobSettledFeedback> | undefined;
    const app = createApp({
      forges,
      exec: new ProvenForgeExec(new FakeForgeExec({ forgeId: "evm-forge" }), forge.sign),
      telemetry,
      settlement: {
        async settleJob(hash: Buffer, sig: Buffer, worker?: string) {
          seen.hash = hash; seen.sig = sig; seen.worker = worker;
          return { jobId: 7, fundTx: "0xfund", releaseTx: "0xrel" };
        },
      },
      forgePubkeyOf: (id) => (id === "evm-forge" ? forge.address : undefined),
      verifyProof: (pub, hash, sig) => evmVerify(pub as Address, hash, sig),
      onSettled: (receipt, _worker, model) => {
        feedback = jobSettledFeedback(receipt, { agentId: 1990n, model, resultHash: seen.hash });
      },
    });

    assert.equal(await chatOk(app), 200);
    const list = await executions(app);
    assert.equal(seen.worker, forge.address);
    assert.equal(seen.sig?.length, 65, "firma EVM r||s||v");
    assert.equal(seen.hash?.length, 32);
    assert.equal(list[0].settle?.status, "settled");
    // El hook ERC-8004 armó el input con evidencia del settle real.
    assert.ok(feedback);
    assert.equal(feedback.agentId, 1990n);
    assert.equal(feedback.tag1, "jobSettled");
    assert.equal(feedback.tag2, "qwen3:4b");
    const evidence = JSON.parse(decodeURIComponent(feedback.feedbackURI!.replace("data:application/json,", "")));
    assert.equal(evidence.jobId, 7);
    assert.equal(evidence.fundTx, "0xfund");
    assert.equal(evidence.releaseTx, "0xrel");
    assert.equal(evidence.resultHash, `0x${seen.hash!.toString("hex")}`);
  });

  it("firma de otra key → ecrecover mismatch → no settlea + breaker", async () => {
    const forge = evmForgeKeypair(FORGE_KEY);
    const impostor = evmForgeKeypair(OTHER_KEY);
    const telemetry = new InMemoryTelemetry();
    let settleCalls = 0;
    const failed: string[] = [];
    const app = createApp({
      forges,
      // El exec firma con la key del impostor pero el registry declara la del forge:
      // ecrecover recupera la address equivocada → verify false.
      exec: new ProvenForgeExec(new FakeForgeExec({ forgeId: "evm-forge" }), impostor.sign),
      telemetry,
      settlement: { async settleJob() { settleCalls++; return { jobId: 1, fundTx: "f", releaseTx: "r" }; } },
      forgePubkeyOf: () => forge.address,
      verifyProof: (pub, hash, sig) => evmVerify(pub as Address, hash, sig),
      breaker: { fail: (id: string) => { failed.push(id); }, ok: () => {} },
    });

    assert.equal(await chatOk(app), 200); // el stream ya salió — la defensa es no pagar
    const list = await executions(app);
    assert.equal(settleCalls, 0);
    assert.deepEqual(failed, ["evm-forge"]);
    assert.deepEqual(list[0].settle, { status: "failed" });
  });

  it("evmVerify fail-closed ante sig malformada (largo inválido)", async () => {
    const forge = evmForgeKeypair(FORGE_KEY);
    assert.equal(await evmVerify(forge.address, Buffer.alloc(32, 1), Buffer.alloc(10, 9)), false);
  });
});
