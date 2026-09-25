// Module ForgeExec — Seam de ejecución. Dos Adapters => Seam real.
// El Scheduler nunca ve Ollama ni HTTP acá, solo este puerto.
export type StreamChunk = { token: string; done: boolean };
// signal: cancelación del cliente (se fue mid-stream). Los adapters que hacen
// red real la propagan a su fetch; si aborta, NO es falla del forge ni retry.
export type ExecRequest = { jobId: string; model: string; prompt: string; signal?: AbortSignal };

export interface ForgeExec {
  readonly forgeId: string;
  readonly model: string;
  execute(req: ExecRequest): AsyncIterable<StreamChunk>;
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
    yield { token: "", done: true };
  }
}
