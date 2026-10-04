// S1 — Scheduler elige HOT aunque el COLD tenga mismo RTT/queue.
// Fuente independiente: literales fijos, no recalculamos con el código.
// Rojo original: sin scheduler, este test fallaba (no existía el Module).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EtrScheduler } from "../src/scheduler.ts";
import type { ForgeView } from "../src/types.ts";

describe("S1 warm-first", () => {
  it("elige forge-hot frente a forge-cold con mismo RTT/queue", () => {
    const s = new EtrScheduler();
    const d = s.select({ id: "j1", model: "qwen3.5:4b" }, [
      { forgeId: "forge-cold", model: "qwen3.5:4b", hot: false, rttMs: 50, queueMs: 100, loadTimeMs: 20000, price: 0.008, reliability: 0.99 },
      { forgeId: "forge-hot", model: "qwen3.5:4b", hot: true, rttMs: 50, queueMs: 100, loadTimeMs: 20000, price: 0.01, reliability: 0.99 },
    ]);
    assert.equal(d.forgeId, "forge-hot");
    assert.equal(d.etrMs, 50 + 100 + 0);
    assert.equal(d.reason, "warm-first");
  });

  it("falla explícito sin candidatos (error, no undefined)", () => {
    const s = new EtrScheduler();
    assert.throws(() => s.select({ id: "j2", model: "qwen3.5:4b" }, []), /sin forges/);
  });

  it("S27: sin forge para el modelo → throw, jamás fallback a forges que no lo sirven", () => {
    const s = new EtrScheduler();
    assert.throws(
      () =>
        s.select({ id: "j3", model: "no-existe:7b" }, [
          { forgeId: "f1", model: "qwen3.5:4b", hot: true, rttMs: 5, queueMs: 0, loadTimeMs: 0, price: 0, reliability: 1 },
        ]),
      /sin forges para no-existe:7b/,
    );
  });
});

describe("S20 ETR medido", () => {
  it("measuredTtftMs reemplaza el estimado y gana con reason measured", () => {
    const s = new EtrScheduler();
    const d = s.select({ id: "j", model: "m" }, [
      { forgeId: "estimado", model: "m", hot: true, rttMs: 50, queueMs: 0, loadTimeMs: 0, price: 0, reliability: 1 },
      { forgeId: "medido", model: "m", hot: true, rttMs: 500, queueMs: 0, loadTimeMs: 0, price: 0, reliability: 1, measuredTtftMs: 8 },
    ]);
    assert.equal(d.forgeId, "medido");
    assert.equal(d.etrMs, 8);
    assert.equal(d.reason, "measured");
  });

  it("forge frío con measured viejo NO lo usa (stale no tapa el load)", () => {
    const s = new EtrScheduler();
    const d = s.select({ id: "j", model: "m" }, [
      { forgeId: "frio", model: "m", hot: false, rttMs: 5, queueMs: 0, loadTimeMs: 2000, price: 0, reliability: 1, measuredTtftMs: 8 },
      { forgeId: "tibio", model: "m", hot: true, rttMs: 50, queueMs: 0, loadTimeMs: 0, price: 0, reliability: 1 },
    ]);
    assert.equal(d.forgeId, "tibio");
    assert.equal(d.reason, "warm-first");
  });
});

describe("spec 013 reputation-weighted routing", () => {
  const fv = (forgeId: string, rttMs: number, reputationScore?: number): ForgeView => ({
    forgeId, model: "m", hot: true, rttMs, queueMs: 0, loadTimeMs: 0, price: 0, reliability: 1,
    ...(reputationScore !== undefined ? { reputationScore } : {}),
  });

  it("rep=0 (default) → ETR puro, comportamiento idéntico a hoy", () => {
    const s = new EtrScheduler();
    const d = s.select({ id: "j", model: "m" }, [fv("rapido", 100, 0), fv("lento-bueno", 110, 1)]);
    assert.equal(d.forgeId, "rapido");
  });

  it("w=0.3: rep 1.0 baja ×0.85 → gana el marginal; reason lleva |rep-boost", () => {
    const s = new EtrScheduler(0.3);
    // etr efectivo: lento-bueno 110×0.85=93.5 < rapido 100×1.15=115 (rep 0)
    const d = s.select({ id: "j", model: "m" }, [fv("rapido", 100, 0), fv("lento-bueno", 110, 1)]);
    assert.equal(d.forgeId, "lento-bueno");
    assert.equal(d.etrMs, 110); // reporta el REAL, no el ponderado
    assert.match(d.reason, /rep-boost/);
  });

  it("la rep desconocida es neutral (0.5 → factor 1.0, ni premio ni castigo)", () => {
    const s = new EtrScheduler(0.3);
    const d = s.select({ id: "j", model: "m" }, [fv("desconocido", 100), fv("bueno", 105, 1)]);
    // desconocido 100×1.0=100 vs bueno 105×0.85=89.25 → gana bueno (rep real pesa)
    assert.equal(d.forgeId, "bueno");
    // pero un neutral claramente más rápido sigue ganando: la rep no invierte
    const d2 = s.select({ id: "j", model: "m" }, [fv("desconocido", 80), fv("bueno", 105, 1)]);
    assert.equal(d2.forgeId, "desconocido"); // 80×1.0=80 < 89.25
  });

  it("la rep NUNCA pone un forge mucho más lento encima (ETR domina)", () => {
    const s = new EtrScheduler(0.3);
    const d = s.select({ id: "j", model: "m" }, [fv("rapido", 100, 0.5), fv("lento", 500, 1)]);
    assert.equal(d.forgeId, "rapido"); // 500×0.85=425 sigue > 100
  });

  it("forge muerto (etr ∞) no resucita por rep", () => {
    const s = new EtrScheduler(0.3);
    const d = s.select({ id: "j", model: "m" }, [
      fv("vivo", 200, 0.5),
      { ...fv("muerto", 0, 1), queueMs: 99999, hot: false },
    ]);
    assert.equal(d.forgeId, "vivo");
  });
});

describe("S28 ETR size-aware", () => {
  const base = { model: "m", hot: true, rttMs: 0, queueMs: 0, loadTimeMs: 0, price: 0, reliability: 1 };

  it("estOutTokens × tokPerSec pesa el decode en la elección", () => {
    const s = new EtrScheduler();
    // rápidoTTFT gana en primer token, pero a 2000 tok el lento decode pierde.
    const d = s.select({ id: "j", model: "m", estOutTokens: 2000 }, [
      { ...base, forgeId: "rapido-lento", measuredTtftMs: 10, tokPerSec: 10 }, // 10 + 200s
      { ...base, forgeId: "lento-rapido", measuredTtftMs: 400, tokPerSec: 100 }, // 400 + 20s
    ]);
    assert.equal(d.forgeId, "lento-rapido");
  });

  it("job sin estOutTokens → ETR es TTFT (comportamiento anterior)", () => {
    const s = new EtrScheduler();
    const d = s.select({ id: "j", model: "m" }, [
      { ...base, forgeId: "rapido-lento", measuredTtftMs: 10, tokPerSec: 10 },
      { ...base, forgeId: "lento-rapido", measuredTtftMs: 400, tokPerSec: 100 },
    ]);
    assert.equal(d.forgeId, "rapido-lento");
  });

  it("forge sin tokPerSec medido → no se le inventa decode", () => {
    const s = new EtrScheduler();
    const d = s.select({ id: "j", model: "m", estOutTokens: 5000 }, [
      { ...base, forgeId: "sin-tok", measuredTtftMs: 10 }, // sin tokPerSec: solo TTFT
      { ...base, forgeId: "con-tok", measuredTtftMs: 400, tokPerSec: 100 },
    ]);
    assert.equal(d.forgeId, "sin-tok");
    assert.equal(d.etrMs, 10);
  });

  it("forge con métricas corruptas (NaN) no gana frente a forge válido", () => {
    const s = new EtrScheduler();
    const d = s.select({ id: "j", model: "m" }, [
      { ...base, forgeId: "corrupto", rttMs: Number.NaN, hot: true },
      { ...base, forgeId: "valido", rttMs: 50, hot: true },
    ]);
    assert.equal(d.forgeId, "valido");
    assert.equal(d.etrMs, 50);
  });
});
