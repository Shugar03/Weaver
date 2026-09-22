// S47 (ADR-0007) — PricingBook: costo por Mtok, imagen flat, minCost.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PricingBook, pricingFromEnv } from "../src/pricing.ts";

const book = new PricingBook({ "qwen3:4b": { prompt: 1_000_000n, completion: 3_000_000n, image: 0n } });

describe("S47 PricingBook", () => {
  it("costOf: prompt×rate + completion×rate, por Mtok", () => {
    // (500_000×1_000_000 + 100_000×3_000_000) / 1_000_000 = 800_000 stroops
    assert.equal(book.costOf("qwen3:4b", { promptTokens: 500_000, completionTokens: 100_000 }), 800_000n);
    assert.equal(book.costOf("qwen3:4b", { promptTokens: 0, completionTokens: 0 }), 0n);
  });

  it("modelo sin precio explícito → fallback; usage vacío → 0", () => {
    assert.equal(book.costOf("desconocido", { promptTokens: 1_000_000 }), 1_000_000n);
    assert.equal(book.costOf("qwen3:4b", {}), 0n);
    assert.equal(book.costOfImage("qwen3:4b"), 0n); // modelo texto: imagen 0
  });

  it("minCost: texto ~margen de decode; imagen = flat", () => {
    assert.ok(book.minCost("qwen3:4b", "text") > 0n);
    assert.equal(book.minCost("qwen3:4b", "image"), 0n);
    const img = new PricingBook({ "flux": { prompt: 0n, completion: 0n, image: 500_000n } });
    assert.equal(img.minCost("flux", "image"), 500_000n);
    assert.equal(img.costOfImage("flux"), 500_000n);
  });

  it("pricingFromEnv: JSON válido parsea; roto → defaults sin crash", () => {
    const p = pricingFromEnv('{"m":{"prompt":10,"completion":20,"image":30}}');
    assert.equal(p.priceFor("m").prompt, 10n);
    assert.equal(p.priceFor("m").image, 30n);
    const d = pricingFromEnv("{json roto");
    assert.ok(d.priceFor("x").prompt > 0n); // fallback default
    const e = pricingFromEnv(undefined);
    assert.ok(e.priceFor("x").completion > 0n);
  });
});
