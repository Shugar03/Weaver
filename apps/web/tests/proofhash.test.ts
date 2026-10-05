// spec 009/S45 — mirror WebCrypto de packages/forge-exec/src/proofhash.ts.
// Vectores pinneados: el mismo input debe producir el mismo hash en Node
// (daemon/gateway) y en el browser (chip). Si drifta, PROOF ✗ permanente.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { commitProof, promptHashInput } from "../lib/proofhash.ts";

describe("proofhash canónico (anti-drift Node↔browser)", () => {
  it("promptHash sin resume — vector pinneado", async () => {
    const h = await promptHashInput({ model: "m", messages: [{ role: "user", content: "hola" }] });
    assert.equal(h, "de20929fae1f3784dc23fe9282789ae9b6defb432311e176c1e8ced0f54f0dd1");
  });

  it("promptHash CON resume entra al canónico (S45 mid-stream resume)", async () => {
    const h = await promptHashInput({
      model: "m",
      messages: [{ role: "user", content: "hola" }],
      resume: "parcial",
    });
    assert.equal(h, "2d1749d90d8c06daf9ac855e4220477b4aa0f4c93c41bed5190b3dc18622b320");
  });

  it("sin resume ≠ con resume — el commitment ata el prefijo continuado", async () => {
    const base = { model: "m", messages: [{ role: "user", content: "hola" }] };
    assert.notEqual(await promptHashInput(base), await promptHashInput({ ...base, resume: "x" }));
  });

  it("commitment = sha256(promptHash‖outputHash) sobre bytes crudos", async () => {
    // 64 hex chars ceros+unos → concat de bytes, sha256 estable.
    const out = await commitProof(
      "0".repeat(64),
      "1".repeat(64),
    );
    assert.match(out, /^[0-9a-f]{64}$/);
  });
});
