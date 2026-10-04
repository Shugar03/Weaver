// spec 009 — verifiable execution receipts.
// El proof L0 (resultHash + firma del forge) viaja en el último frame SSE /
// response non-stream como `weaver_proof`, y se persiste con el sample para
// lookup por /v1/executions?jobId=. Sin proof → el campo falta, jamás null.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.ts";
import { FakeForgeExec } from "@weaver/forge-exec";
import { InMemoryTelemetry } from "@weaver/telemetry";
import type { Sample } from "@weaver/telemetry";

const forges = () => [
  { forgeId: "forge-sim-01", model: "qwen3:4b", hot: true, rttMs: 1, queueMs: 0, loadTimeMs: 0, price: 0, reliability: 1 },
];
const chat = (stream: boolean) =>
  JSON.stringify({ model: "qwen3:4b", messages: [{ role: "user", content: "hola" }], stream });

type ProofPayload = {
  jobId: string;
  forgeId: string;
  resultHash: string;
  signature: string;
  signer?: string;
};

// FakeForgeExec firma un proof determinístico: hash = 32×0x01, sig = 64×0x02.
const FAKE_HASH = "01".repeat(32);
const FAKE_SIG = `0x${"02".repeat(64)}`;

describe("spec 009 — verifiable receipts", () => {
  it("SSE: el último data-frame lleva weaver_proof con el receipt", async () => {
    const app = createApp({ forges, exec: new FakeForgeExec({ forgeId: "forge-sim-01" }), telemetry: new InMemoryTelemetry() });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chat(true),
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    const frames = text
      .split("\n\n")
      .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
      .map((l) => JSON.parse(l.slice(6)) as { weaver_proof?: ProofPayload });
    const last = frames.at(-1)!;
    assert.ok(last.weaver_proof, "el frame final debe llevar weaver_proof");
    const p = last.weaver_proof!;
    assert.equal(p.forgeId, "forge-sim-01");
    assert.equal(p.resultHash, FAKE_HASH);
    assert.equal(p.signature, FAKE_SIG);
    assert.match(p.jobId, /^chatcmpl-/);
    // Los frames intermedios NO llevan receipt — solo el final.
    assert.ok(frames.slice(0, -1).every((f) => f.weaver_proof === undefined));
  });

  it("non-stream: weaver_proof en el JSON de respuesta", async () => {
    const app = createApp({ forges, exec: new FakeForgeExec({ forgeId: "forge-sim-01" }) });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chat(false),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { weaver_proof?: ProofPayload };
    assert.equal(body.weaver_proof?.resultHash, FAKE_HASH);
    assert.equal(body.weaver_proof?.forgeId, "forge-sim-01");
  });

  it("signer viaja cuando el forge está en registry (verify-side hint)", async () => {
    const app = createApp({
      forges,
      exec: new FakeForgeExec({ forgeId: "forge-sim-01" }),
      forgePubkeyOf: (id) => (id === "forge-sim-01" ? "0x74827c8fC2B33D4f4d0a94e3C1d0f4b9d90A2F6D" : undefined),
      verifyProof: async () => true,
    });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chat(false),
    });
    const body = (await res.json()) as { weaver_proof?: ProofPayload };
    assert.equal(body.weaver_proof?.signer, "0x74827c8fC2B33D4f4d0a94e3C1d0f4b9d90A2F6D");
  });

  it("el receipt se persiste: /v1/executions?jobId= lo devuelve", async () => {
    const app = createApp({ forges, exec: new FakeForgeExec({ forgeId: "forge-sim-01" }), telemetry: new InMemoryTelemetry() });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chat(false),
    });
    const { weaver_proof: p } = (await res.json()) as { weaver_proof: ProofPayload };
    // record() es fire-and-forget — poll hasta que el sample exista.
    const deadline = Date.now() + 3000;
    let found: Sample[] = [];
    for (;;) {
      found = (await (await app.request(`/v1/executions?jobId=${p.jobId}`)).json()) as Sample[];
      if (found.length > 0 || Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(found.length, 1);
    const s = found[0];
    assert.equal(s.jobId, p.jobId);
    assert.equal(s.resultHash, FAKE_HASH);
    assert.equal(s.proofSig, FAKE_SIG);
    // jobId inexistente → lista vacía honesta.
    const none = (await (await app.request("/v1/executions?jobId=chatcmpl-nope")).json()) as Sample[];
    assert.deepEqual(none, []);
  });

  it("job sin proof → sample sin campos receipt, response sin weaver_proof", async () => {
    class NoProofExec extends FakeForgeExec {
      override async *execute(req: Parameters<FakeForgeExec["execute"]>[0]) {
        yield* super.execute({ ...req, onProof: undefined }); // jamás emite proof
      }
    }
    const app = createApp({ forges, exec: new NoProofExec({ forgeId: "forge-sim-01" }) });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chat(false),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { weaver_proof?: unknown };
    assert.equal(body.weaver_proof, undefined);
  });
});
