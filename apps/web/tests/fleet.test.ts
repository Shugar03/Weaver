// S26 — derivación forge→fila de la fleet: reglas puras, sin DOM.
// Regla de oro: solo lo medido o lo declarado honesto — jamás métricas fabricadas.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { forgeRow, type ExecSample, type ForgeViewLike } from "../lib/fleet.ts";

const base: ForgeViewLike = {
  forgeId: "f1",
  model: "qwen3:4b",
  hot: true,
  queueMs: 0,
  loadTimeMs: 0,
};

const exec = (forgeId: string, ttftMs = 100, ok = true): ExecSample => ({
  forgeId,
  model: "m",
  ttftMs,
  ok,
  ts: Date.now(),
});

describe("forgeRow", () => {
  it("texto HOT con p50 medido → 'p50 Xs' (medido, no estimado)", () => {
    const r = forgeRow({ ...base, measuredTtftMs: 1891 }, []);
    assert.equal(r.status, "hot");
    assert.equal(r.metric, "p50 1.89s");
  });

  it("texto HOT sin medición → 'warm' honesto, no un número inventado", () => {
    const r = forgeRow({ ...base }, []);
    assert.equal(r.status, "hot");
    assert.equal(r.metric, "warm");
  });

  it("texto COLD vivo → 'load ~Ns' del loadTime declarado", () => {
    const r = forgeRow({ ...base, hot: false, loadTimeMs: 20_000 }, []);
    assert.equal(r.status, "cold");
    assert.equal(r.metric, "load ~20s");
  });

  it("imagen → 'Ns/img' del último job real; sin jobs → '~Ns/img' declarado", () => {
    const img = { ...base, forgeId: "image-local", model: "flux2-klein-4b", capability: "image" as const, hot: false, loadTimeMs: 20_000 };
    assert.equal(forgeRow(img, []).metric, "~20s/img");
    assert.equal(forgeRow(img, [exec("image-local", 15360)]).metric, "15.4s/img");
  });

  it("queueMs 99999 = marcador de muerto → DEAD sin métrica", () => {
    const r = forgeRow({ ...base, hot: false, queueMs: 99_999 }, []);
    assert.equal(r.status, "dead");
    assert.equal(r.metric, "—");
  });

  it("sim es badge, no status: standby COLD sigue siendo cold + sim", () => {
    const r = forgeRow({ ...base, forgeId: "forge-sim-01", sim: true, hot: false, loadTimeMs: 4000 }, []);
    assert.equal(r.status, "cold");
    assert.equal(r.sim, true);
  });

  it("jobs = count de execs de ESTE forge; lastMs = el último ok", () => {
    // recent() devuelve más nuevo primero → el último ok de f1 es 300.
    const exs = [exec("f1", 300), exec("f1", 900, false), exec("otro", 100), exec("f1", 500)];
    const r = forgeRow(base, exs);
    assert.equal(r.jobs, 3);
    assert.equal(r.lastMs, 300);
  });

  it("href al detalle del forge", () => {
    assert.equal(forgeRow(base, []).href, "/forge/f1");
  });

  it("S29: saturated → busy (badge BUSY); dead gana → busy false", () => {
    assert.equal(forgeRow({ ...base, saturated: true, inFlight: 4 }, []).busy, true);
    assert.equal(forgeRow({ ...base, saturated: true, queueMs: 99_999 }, []).busy, false);
    assert.equal(forgeRow({ ...base, saturated: false, inFlight: 2 }, []).busy, false);
  });
});
