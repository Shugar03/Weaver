// Spec 002 — el sample persiste el ETR que el router predijo para el forge
// que SIRVIÓ (no el de otro candidato): base de la calibración visible.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.ts";
import { FakeForgeExec } from "@weaver/forge-exec";
import { InMemoryTelemetry } from "@weaver/telemetry";

const forges = () => [
  { forgeId: "f", model: "qwen3:4b", hot: true, rttMs: 1, queueMs: 0, loadTimeMs: 0, price: 0, reliability: 1 },
];
const chat = (app: ReturnType<typeof createApp>) =>
  app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "qwen3:4b", messages: [{ role: "user", content: "hi" }] }),
  });

describe("ETR calibration — predictedMs en el sample", () => {
  it("con predictedEtrOf el sample lleva la predicción del forge servido", async () => {
    const telemetry = new InMemoryTelemetry();
    const etrs = new Map<string, number>([["f", 420]]);
    const app = createApp({
      forges,
      exec: new FakeForgeExec({ forgeId: "f", model: "qwen3:4b" }),
      telemetry,
      predictedEtrOf: (jobId, forgeId) => (jobId.startsWith("chatcmpl-") ? etrs.get(forgeId) : undefined),
    });
    const res = await chat(app);
    assert.equal(res.status, 200);
    await res.json();
    const [sample] = await telemetry.recent(1);
    assert.equal(sample.forgeId, "f");
    assert.equal(sample.predictedMs, 420);
  });

  it("sin predictedEtrOf (dep ausente) el sample queda sin predictedMs — honesto", async () => {
    const telemetry = new InMemoryTelemetry();
    const app = createApp({ forges, exec: new FakeForgeExec({ forgeId: "f", model: "qwen3:4b" }), telemetry });
    const res = await chat(app);
    assert.equal(res.status, 200);
    await res.json();
    const [sample] = await telemetry.recent(1);
    assert.equal(sample.predictedMs, undefined);
  });

  it("jobId desconocido / forge distinto → undefined, jamás inventado", async () => {
    const telemetry = new InMemoryTelemetry();
    const app = createApp({
      forges,
      exec: new FakeForgeExec({ forgeId: "f", model: "qwen3:4b" }),
      telemetry,
      predictedEtrOf: () => undefined,
    });
    const res = await chat(app);
    assert.equal(res.status, 200);
    await res.json();
    const [sample] = await telemetry.recent(1);
    assert.equal(sample.predictedMs, undefined);
  });
});
