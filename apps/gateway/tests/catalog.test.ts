// S48 (ADR-0007 P6) — /v1/catalog: join de metadata declarada (MODEL_CATALOG)
// + fleet viva + pricing + medidas de telemetría. Lo no declarado sale
// explícitamente ausente; lo no medido sale null — jamás inventado.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.ts";
import { PricingBook } from "@weaver/accounts";
import type { ForgeView } from "@weaver/scheduler";

const forges = (): ForgeView[] => [
  {
    forgeId: "f1",
    model: "qwen3:4b",
    hot: true,
    rttMs: 1,
    queueMs: 0,
    loadTimeMs: 0,
    price: 0,
    reliability: 0.99,
    measuredTtftMs: 210,
    tokPerSec: 42.5,
  },
  {
    forgeId: "f2",
    model: "qwen3:4b",
    hot: false,
    rttMs: 5,
    queueMs: 0,
    loadTimeMs: 800,
    price: 0,
    reliability: 0.97,
    measuredTtftMs: 320,
    tokPerSec: 30,
  },
  // modelo sin metadata declarada — aparece por la fleet sola
  { forgeId: "f3", model: "flux:schnell", capability: "image", hot: true, rttMs: 1, queueMs: 0, loadTimeMs: 0, price: 0, reliability: 1 },
];

type CatalogEntry = {
  id: string;
  declared: boolean;
  pricing: { prompt: string | null; completion: string | null; image: string | null };
  availability: { providers: number; hot: number; available: boolean };
  measured: { ttftMsP50: number | null; tokPerSec: number | null };
};

const setup = () =>
  createApp({
    forges,
    pricing: new PricingBook({ "qwen3:4b": { prompt: 1000n, completion: 3000n, image: 0n } }),
    catalog: {
      "qwen3:4b": {
        name: "Qwen3 4B",
        description: "coder liviano",
        context: 32768,
        features: ["tools", "reasoning"],
        docs: "https://ollama.com/library/qwen3",
      },
    },
  });

describe("S48 /v1/catalog", () => {
  it("une metadata declarada + fleet + pricing + medidas", async () => {
    const res = await setup().request("/v1/catalog");
    assert.equal(res.status, 200);
    const j = (await res.json()) as { models: CatalogEntry[] };
    const q = j.models.find((m) => m.id === "qwen3:4b")!;
    assert.equal(q.declared, true);
    assert.equal(q.pricing.prompt, "1000");
    assert.equal(q.availability.providers, 2);
    assert.equal(q.availability.hot, 1);
    assert.equal(q.availability.available, true);
    // medido: mejor TTFT de los providers vivos, tok/s máximo
    assert.equal(q.measured.ttftMsP50, 210);
    assert.equal(q.measured.tokPerSec, 42.5);
  });

  it("modelo de fleet sin metadata → declared:false, measured null si no hay samples", async () => {
    const j = (await (await setup().request("/v1/catalog")).json()) as { models: CatalogEntry[] };
    const flux = j.models.find((m) => m.id === "flux:schnell")!;
    assert.equal(flux.declared, false);
    assert.equal(flux.pricing.image, null); // sin pricing declarado
    assert.equal(flux.measured.ttftMsP50, null);
    assert.equal(flux.availability.providers, 1);
  });

  it("sin catálogo declarado ni pricing → solo fleet, campos honestos", async () => {
    const app = createApp({ forges });
    const j = (await (await app.request("/v1/catalog")).json()) as { models: CatalogEntry[] };
    assert.equal(j.models.length, 2);
    assert.ok(j.models.every((m) => m.declared === false));
    assert.ok(j.models.every((m) => m.pricing.prompt === null));
  });
});
