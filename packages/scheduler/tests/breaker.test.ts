// S27 — CircuitBreaker: N fallos consecutivos recientes → forge fuera T ms.
// Puro: tiempo inyectado, sin I/O. Un éxito resetea; los fallos viejos no
// cuentan (ventana). applyBreaker marca views con queueMs=99999 (dead-marker
// que la UI ya lee como DEAD — honesto: está no-disponible por fallos).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyBreaker, CircuitBreaker, queueMsFor } from "../src/breaker.ts";

describe("S27 CircuitBreaker", () => {
  it("3 fallos consecutivos → abierto por 30s", () => {
    const b = new CircuitBreaker();
    const t = 1_000_000;
    b.fail("f1", t);
    b.fail("f1", t + 100);
    assert.equal(b.isOpen("f1", t + 200), false); // 2 fallos: aún no
    b.fail("f1", t + 300);
    assert.equal(b.isOpen("f1", t + 400), true); // 3 → abierto
    assert.equal(b.isOpen("f1", t + 300 + 29_999), true); // aún abierto
    assert.equal(b.isOpen("f1", t + 300 + 30_001), false); // expiró
  });

  it("un éxito resetea los fallos consecutivos", () => {
    const b = new CircuitBreaker();
    const t = 1_000_000;
    b.fail("f1", t);
    b.fail("f1", t + 1);
    b.ok("f1"); // sirvió: contador a cero
    b.fail("f1", t + 2);
    b.fail("f1", t + 3);
    assert.equal(b.isOpen("f1", t + 4), false); // solo 2 desde el reset
  });

  it("fallos fuera de la ventana de 60s no cuentan", () => {
    const b = new CircuitBreaker();
    const t = 1_000_000;
    b.fail("f1", t);
    b.fail("f1", t + 61_000); // el primero ya expiró
    b.fail("f1", t + 61_001);
    assert.equal(b.isOpen("f1", t + 61_002), false); // 2 recientes, no 3
  });

  it("fallos de un forge no afectan a otro", () => {
    const b = new CircuitBreaker();
    b.fail("f1");
    b.fail("f1");
    b.fail("f1");
    assert.equal(b.isOpen("f1"), true);
    assert.equal(b.isOpen("f2"), false);
  });
});

describe("S27 applyBreaker", () => {
  it("forge abierto → queueMs 99999 (dead-marker); el resto intacto", () => {
    const b = new CircuitBreaker();
    const t = 1_000_000;
    b.fail("bad", t);
    b.fail("bad", t + 1);
    b.fail("bad", t + 2);
    const views = [
      { forgeId: "bad", model: "m", hot: true, rttMs: 5, queueMs: 0, loadTimeMs: 0, price: 0, reliability: 1 },
      { forgeId: "good", model: "m", hot: true, rttMs: 5, queueMs: 0, loadTimeMs: 0, price: 0, reliability: 1 },
    ];
    const out = applyBreaker(views, b, t + 3);
    assert.equal(out[0].queueMs, 99_999);
    assert.equal(out[1].queueMs, 0);
  });
});

describe("S27 queueMsFor", () => {
  it("cola medida = in-flight × esperado por job", () => {
    assert.equal(queueMsFor(0, 1500), 0);
    assert.equal(queueMsFor(2, 1500), 3000);
    assert.equal(queueMsFor(4, 20_000), 80_000);
  });
});
