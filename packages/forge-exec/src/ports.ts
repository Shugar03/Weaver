// Module ForgeExec — Seam de ejecución. Dos Adapters => Seam real.
// El Scheduler nunca ve Ollama ni HTTP acá, solo este puerto.
export type StreamChunk = { token: string; done: boolean };
// Proof L0 (S23): recibo del forge — sha256 de SU output + firma ed25519.
// El contrato lo verifica en release: pago condicionado a entrega probada.
export type Proof = { forgeId: string; resultHash: Buffer; signature: Buffer };
// onForge: quién emitió el primer token. onProof: recibo firmado al completar.
// Ambos por request — sin estado compartido entre requests concurrentes.
export type ExecRequest = {
  jobId: string;
  model: string;
  prompt: string;
  onForge?: (forgeId: string) => void;
  onProof?: (proof: Proof) => void;
};

export interface ForgeExec {
  readonly forgeId: string;
  readonly model: string;
  execute(req: ExecRequest): AsyncIterable<StreamChunk>;
  // Liveness barato para el registry (S24): ausente = "no sé, suponé vivo".
  probe?(): Promise<boolean>;
}

// Adapter fake para tests y standby simulado (badge SIM en UI, jamás se hace pasar por real).
export class FakeForgeExec implements ForgeExec {
  readonly forgeId: string;
  readonly model: string;

  constructor(opts: { forgeId?: string; model?: string } = {}) {
    this.forgeId = opts.forgeId ?? "fake-forge";
    this.model = opts.model ?? "qwen3:4b";
  }
  async *execute(req: ExecRequest): AsyncIterable<StreamChunk> {
    yield { token: `echo:${req.prompt.slice(0, 24)}`, done: false };
    // Proof fake determinístico: la verificación real vive en el contrato.
    req.onProof?.({
      forgeId: this.forgeId,
      resultHash: Buffer.alloc(32, 1),
      signature: Buffer.alloc(64, 2),
    });
    yield { token: "", done: true };
  }
  async probe(): Promise<boolean> {
    return true;
  }
}
