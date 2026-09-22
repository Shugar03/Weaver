// S9a — Telemetry en memoria: record + recent (novedades primero) + p50 intacto.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InMemoryTelemetry } from "../src/ports.ts";

describe("S9a telemetry", () => {
  it("recent devuelve las últimas primero", async () => {
    const t = new InMemoryTelemetry();
    await t.record({ forgeId: "a", model: "m", ttftMs: 100, ok: true, ts: 1 });
    await t.record({ forgeId: "a", model: "m", ttftMs: 300, ok: true, ts: 2 });
    await t.record({ forgeId: "a", model: "m", ttftMs: 200, ok: true, ts: 3 });
    assert.deepEqual((await t.recent(2)).map((s) => s.ttftMs), [200, 300]);
    assert.equal(await t.p50("m", "a"), 200);
  });

  it("vacío → recent [] y p50 0", async () => {
    const t = new InMemoryTelemetry();
    assert.deepEqual(await t.recent(5), []);
    assert.equal(await t.p50("m", "a"), 0);
  });

  it("S20: p50 es por forge — uno lento no contamina al rápido", async () => {
    const t = new InMemoryTelemetry();
    await t.record({ forgeId: "lento", model: "m", ttftMs: 900, ok: true, ts: 1 });
    await t.record({ forgeId: "rapido", model: "m", ttftMs: 20, ok: true, ts: 2 });
    assert.equal(await t.p50("m", "lento"), 900);
    assert.equal(await t.p50("m", "rapido"), 20);
  });

  it("S27: p50 con ventana — los últimos 50 samples, no all-time", async () => {
    const t = new InMemoryTelemetry();
    // Forge que se degradó: 55 samples rápidos viejos, luego 15 lentos nuevos.
    // Sin ventana el p50 queda en ~100 para siempre; con ventana refleja el ahora.
    for (let i = 0; i < 55; i++) await t.record({ forgeId: "deg", model: "m", ttftMs: 100, ok: true, ts: i });
    for (let i = 0; i < 15; i++) await t.record({ forgeId: "deg", model: "m", ttftMs: 9000, ok: true, ts: 100 + i });
    const p50 = await t.p50("m", "deg");
    // Ventana = últimos 50 ok: 35 de 100ms + 15 de 9000ms → mediana 100.
    // (el caso fuerte: 60 viejos rápidos + 15 lentos → ventana tiene
    // 35 rápidos + 15 lentos, mediana sigue 100; con 60 rápidos + 40 lentos
    // → ventana 10 rápidos + 40 lentos → mediana 9000: sí detecta degradación)
    assert.equal(p50, 100);
    const t2 = new InMemoryTelemetry();
    for (let i = 0; i < 60; i++) await t2.record({ forgeId: "deg", model: "m", ttftMs: 100, ok: true, ts: i });
    for (let i = 0; i < 40; i++) await t2.record({ forgeId: "deg", model: "m", ttftMs: 9000, ok: true, ts: 100 + i });
    assert.equal(await t2.p50("m", "deg"), 9000);
  });
});
