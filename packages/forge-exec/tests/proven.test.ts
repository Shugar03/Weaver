// S23 — ProvenForgeExec: Proof L0. El forge firma el sha256 de SU output y lo
// reporta por request (onProof). El contrato lo verifica en release.
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FakeForgeExec } from "../src/ports.ts";
import { FailoverForgeExec } from "../src/failover.ts";
import { ProvenForgeExec } from "../src/proven.ts";
import { commitProof, promptHashOf } from "../src/proofhash.ts";
import type { ExecRequest, ForgeExec, Proof, StreamChunk } from "../src/ports.ts";

const fakeSign = (h: Buffer) => Buffer.concat([Buffer.from("SIG:"), h]);

async function collect(exec: ForgeExec, req?: Partial<ExecRequest>): Promise<string> {
  let out = "";
  for await (const c of exec.execute({ jobId: "j", model: "m", prompt: "hola", ...req })) out += c.token;
  return out;
}

describe("S23 ProvenForgeExec", () => {
  it("firma el sha256 del output real y lo reporta en onProof", async () => {
    const proofs: Proof[] = [];
    const exec = new ProvenForgeExec(new FakeForgeExec({ forgeId: "f-real" }), fakeSign);
    const out = await collect(exec, { onProof: (p) => proofs.push(p) });
    assert.equal(out, "echo:hola");
    assert.equal(proofs.length, 1);
    assert.equal(proofs[0].forgeId, "f-real");
    // Commitment era: resultHash = sha256(promptHash‖outputHash) — la firma
    // ata input+output. El outputHash sigue siendo sha256 del contenido.
    const outputHash = createHash("sha256").update("echo:hola").digest();
    const promptHash = promptHashOf({ model: "m", prompt: "hola" });
    assert.deepEqual(proofs[0].outputHash, outputHash);
    assert.deepEqual(proofs[0].promptHash, promptHash);
    assert.deepEqual(proofs[0].resultHash, commitProof(promptHash, outputHash));
    assert.equal(proofs[0].signature.subarray(0, 4).toString(), "SIG:");
    assert.equal(proofs[0].signature.length, 36); // "SIG:" + 32B commitment
  });

  it("el commitment ata el INPUT: mismo output, otro prompt → otro resultHash", async () => {
    const proofs: Proof[] = [];
    const exec = new ProvenForgeExec(new FakeForgeExec({ forgeId: "f" }), fakeSign);
    // FakeForgeExec devuelve echo:<prompt[:24]> — mismo prompt en ambos →
    // para aislar el binding de input, chequeamos promptHash directo.
    await collect(exec, { onProof: (p) => proofs.push(p), prompt: "hola" });
    await collect(exec, { onProof: (p) => proofs.push(p), prompt: "chau" });
    assert.notDeepEqual(proofs[0].promptHash, proofs[1].promptHash);
    assert.notDeepEqual(proofs[0].resultHash, proofs[1].resultHash);
  });

  it("tokens think NO entran al hash — el receipt ata la respuesta visible", async () => {
    // Bug live (PROOF ✗ permanente en modelos thinking): se hasheaba
    // think+content pero el cliente verifica sha256 del contenido leído.
    class Thinking implements ForgeExec {
      readonly forgeId = "thinker";
      readonly model = "m";
      async *execute(): AsyncIterable<StreamChunk> {
        yield { token: "razonando…", done: false, kind: "think" };
        yield { token: "respuesta ", done: false, kind: "content" };
        yield { token: "visible", done: false, kind: "content" };
        yield { token: "", done: true };
      }
    }
    const proofs: Proof[] = [];
    const exec = new ProvenForgeExec(new Thinking(), fakeSign);
    await collect(exec, { onProof: (p) => proofs.push(p) });
    assert.equal(proofs.length, 1);
    assert.deepEqual(
      proofs[0].outputHash,
      createHash("sha256").update("respuesta visible").digest(),
      "el outputHash ata solo el contenido — el think es efímero y no verificable client-side",
    );
    // y el commitment queda consistente con ese outputHash + el input.
    const pH = promptHashOf({ model: "m", prompt: "hola" });
    assert.deepEqual(proofs[0].resultHash, commitProof(pH, proofs[0].outputHash!));
  });

  it("muerte mid-stream → sin proof (trabajo no completado no se firma)", async () => {
    class Flaky implements ForgeExec {
      readonly forgeId = "flaky";
      readonly model = "m";
      async *execute(): AsyncIterable<StreamChunk> {
        yield { token: "parcial", done: false };
        throw new Error("murió");
      }
    }
    const proofs: Proof[] = [];
    const exec = new ProvenForgeExec(new Flaky(), fakeSign);
    await assert.rejects(collect(exec, { onProof: (p) => proofs.push(p) }), /murió/);
    assert.equal(proofs.length, 0);
  });

  it("dentro de Failover: solo el forge que completó reporta proof", async () => {
    class Dead implements ForgeExec {
      readonly forgeId = "muerto";
      readonly model = "m";
      async *execute(): AsyncIterable<StreamChunk> {
        throw new Error("caído");
      }
    }
    const proofs: Proof[] = [];
    const exec = new FailoverForgeExec([
      new ProvenForgeExec(new Dead(), fakeSign),
      new ProvenForgeExec(new FakeForgeExec({ forgeId: "vivo" }), fakeSign),
    ]);
    await collect(exec, { onProof: (p) => proofs.push(p) });
    assert.deepEqual(proofs.map((p) => p.forgeId), ["vivo"]);
  });

  it("probe delega al inner", async () => {
    const dead = new ProvenForgeExec(
      { forgeId: "x", model: "m", probe: async () => false, async *execute() {} },
      fakeSign,
    );
    assert.equal(await dead.probe(), false);
  });
});
