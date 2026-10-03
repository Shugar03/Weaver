// Edge cases del boundary HTTP/stream que los suites temáticos no cubren:
// - output vacío: el forge sirvió 0 tokens → NO emite proof → settle failed.
//   Semántica fail-closed correcta: nada entregado = nada que probar = nada
//   pagado. El stream igual cierra 200 (el cliente recibió el vacío honesto).
// - caps de input: prompt >60k y >60 mensajes → 413 antes de tocar la fleet;
//   body sin un solo mensaje válido → 400 (antes servía contexto vacío).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.ts";
import { FakeForgeExec, ProvenForgeExec } from "@weaver/forge-exec";
import type { ForgeExec, ExecRequest, StreamChunk } from "@weaver/forge-exec";
import { dualVerify, evmForgeKeypair } from "@weaver/settlement";
import { InMemoryTelemetry } from "@weaver/telemetry";
import type { Hex } from "viem";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const forges = () => [
  { forgeId: "f", model: "qwen3:4b", hot: true, rttMs: 1, queueMs: 0, loadTimeMs: 0, price: 0, reliability: 1 },
];

class EmptyForgeExec implements ForgeExec {
  readonly forgeId = "f";
  readonly model = "qwen3:4b";
  async *execute(_req: ExecRequest): AsyncIterable<StreamChunk> {
    // Cero chunks — el stream abre y cierra sin un solo token.
    return;
  }
}

describe("edge: output vacío → sin proof → no se paga (nada entregado)", () => {
  it("forge devuelve 0 tokens: settle failed, nunca invoca settleJob", async () => {
    const forge = evmForgeKeypair(KEY);
    const telemetry = new InMemoryTelemetry();
    let settleCalls = 0;
    const app = createApp({
      forges,
      exec: new ProvenForgeExec(new EmptyForgeExec(), forge.sign),
      telemetry,
      settlement: {
        async settleJob() {
          settleCalls++;
          return { jobId: 1, fundTx: "f", releaseTx: "r" };
        },
      },
      forgePubkeyOf: () => forge.address,
      verifyProof: dualVerify,
    });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "qwen3:4b", stream: true, messages: [{ role: "user", content: "hola" }] }),
    });
    await res.text();
    assert.equal(res.status, 200); // el stream cerró limpio con output vacío
    const deadline = Date.now() + 3000;
    for (;;) {
      const list = (await (await app.request("/v1/executions")).json()) as { settle?: { status?: string } }[];
      if (list.length > 0) {
        assert.equal(list[0].settle?.status, "failed");
        break;
      }
      if (Date.now() > deadline) assert.fail("sample nunca llegó");
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(settleCalls, 0, "sin proof no se invoca settleJob");
  });
});

describe("edge: caps de input (413 antes de tocar la fleet)", () => {
  const app = createApp({ forges, exec: new FakeForgeExec({ forgeId: "f" }) });
  const post = (body: unknown) =>
    app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("prompt >60k chars → 413 prompt_too_large", async () => {
    const res = await post({ model: "qwen3:4b", messages: [{ role: "user", content: "x".repeat(60_001) }] });
    assert.equal(res.status, 413);
    const j = (await res.json()) as { code?: string };
    assert.equal(j.code, "prompt_too_large");
  });

  it(">60 mensajes → 413 aunque cada uno sea chico", async () => {
    const messages = Array.from({ length: 61 }, (_, i) => ({ role: "user", content: `m${i}` }));
    const res = await post({ model: "qwen3:4b", messages });
    assert.equal(res.status, 413);
  });

  it("mensajes malformados (content no-string) se filtran sin explotar", async () => {
    const res = await post({
      model: "qwen3:4b",
      messages: [
        { role: "user", content: "ok" },
        { role: "user", content: 42 },
        null,
        { role: "assistant" },
      ],
    });
    assert.equal(res.status, 200);
    await res.text();
  });

  it("body sin messages → 400 bad_request (no sirve contexto vacío)", async () => {
    const res = await post({ model: "qwen3:4b" });
    assert.equal(res.status, 400);
    const j = (await res.json()) as { code?: string };
    assert.equal(j.code, "bad_request");
  });

  it("messages presentes pero TODOS malformados → 400 también", async () => {
    const res = await post({ model: "qwen3:4b", messages: [{ content: 42 }, null, "x"] });
    assert.equal(res.status, 400);
  });
});
