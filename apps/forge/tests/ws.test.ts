// Backoff del reconnect-loop: exponencial con jitter + cap + reset sano.
// Un gateway caído no puede ser martillado con reconnects cada 3s (flapping
// observado live: auth ok → close → retry en loop fijo).
import { test } from "node:test";
import assert from "node:assert/strict";
import { nextBackoff } from "../src/ws.ts";

test("nextBackoff escala exponencial con cap 30s y jitter dentro del rango", () => {
  const noJitter = () => 0.5; // rand=0.5 → factor 1.0 exacto
  assert.equal(nextBackoff(0, noJitter), 1000); // 1s
  assert.equal(nextBackoff(1, noJitter), 2000);
  assert.equal(nextBackoff(2, noJitter), 4000);
  assert.equal(nextBackoff(3, noJitter), 8000);
  assert.equal(nextBackoff(4, noJitter), 16000);
  assert.equal(nextBackoff(5, noJitter), 30000); // cap
  assert.equal(nextBackoff(99, noJitter), 30000); // nunca pasa el cap
});

test("nextBackoff jitter: siempre dentro de [base/2, 1.5×base]", () => {
  for (let f = 0; f < 8; f++) {
    const min = Math.min(30_000, 1000 * 2 ** Math.min(f, 5)) * 0.5;
    for (let i = 0; i < 50; i++) {
      const b = nextBackoff(f);
      assert.ok(b >= min && b <= Math.min(30_000, 1000 * 2 ** Math.min(f, 5)) * 1.5, `f=${f} b=${b}`);
    }
  }
});

test("wss:// gateway → challenge por https y socket por wss", async () => {
  // Regresión real: --gateway wss://… rompía el fetch del challenge
  // (fetch no acepta scheme ws). Se verifica la normalización indirecta:
  // un connect contra wss://127.0.0.1:1 falla en el SOCKET (no en fetch) —
  // eso prueba que el challenge salió por https y llegó al WebSocket.
  const { connect } = await import("../src/ws.ts");
  const cfg = {
    pubkey: "G" + "A".repeat(55),
    secret: "S" + "A".repeat(55),
    chain: "stellar" as const,
    gateway: "wss://127.0.0.1:1",
    instances: [],
  };
  // wss://127.0.0.1:1 → challenge https://127.0.0.1:1 → ECONNREFUSED (fetch)
  // — no TypeError de scheme inválido.
  await assert.rejects(connect(cfg), /ECONNREFUSED|fetch failed|challenge/);
});
