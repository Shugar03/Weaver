// Proof L0 (S23): envuelve un ForgeExec y firma el sha256 de su propio output.
// El recibo (hash + firma ed25519) viaja por req.onProof al gateway, que lo manda
// al contrato — release revierte si la firma no es del forge registrado.
// El signer es una función inyectada (forge-exec no conoce stellar-sdk).
import { createHash } from "node:crypto";
import type { ExecRequest, ForgeExec, StreamChunk } from "./ports.ts";

// EVM: el signer puede ser async (viem signMessage es Promise) — el Soroban
// ed25519 era sync; se acepta cualquiera de los dos.
export type ResultSigner = (resultHash: Buffer) => Buffer | Promise<Buffer>;

export class ProvenForgeExec implements ForgeExec {
  private readonly inner: ForgeExec;
  private readonly sign: ResultSigner;

  constructor(inner: ForgeExec, sign: ResultSigner) {
    this.inner = inner;
    this.sign = sign;
  }

  get forgeId(): string {
    return this.inner.forgeId;
  }
  get model(): string {
    return this.inner.model;
  }
  probe(): Promise<boolean> {
    return this.inner.probe?.() ?? Promise.resolve(true);
  }
  resident(): Promise<boolean> {
    return this.inner.resident?.() ?? Promise.resolve(true);
  }

  async *execute(req: ExecRequest): AsyncIterable<StreamChunk> {
    const hasher = createHash("sha256");
    // El proof lo emite ESTE wrapper (firmado) — se suprime el del inner para que
    // un FakeForgeExec dentro no reporte dos recibos del mismo output.
    for await (const chunk of this.inner.execute({ ...req, onProof: undefined })) {
      if (chunk.done) {
        const resultHash = hasher.digest();
        req.onProof?.({
          forgeId: this.inner.forgeId,
          resultHash,
          signature: await this.sign(resultHash),
        });
      } else {
        // Solo el contenido entra al hash — los tokens think (qwen3) son
        // razonamiento efímero: el cliente verifica sha256 del texto leído,
        // y el escrow libera contra lo que el usuario vio. Bug medido live:
        // hashear think+content daba PROOF ✗ permanente en el chip.
        if (chunk.kind !== "think") hasher.update(chunk.token);
      }
      yield chunk;
    }
  }
}
