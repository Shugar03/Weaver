// Module ForgeExec — Seam de ejecución. Dos Adapters => Seam real.
// El Scheduler nunca ve Ollama ni HTTP acá, solo este puerto.
export type StreamChunk = { token: string; done: boolean };
export type ExecRequest = { jobId: string; model: string; prompt: string };

export interface ForgeExec {
  readonly forgeId: string;
  readonly model: string;
  execute(req: ExecRequest): AsyncIterable<StreamChunk>;
}

// Adapter fake para tests y gateway sin GPU (S2). Reemplaza sin tocar callers (LSP).
export class FakeForgeExec implements ForgeExec {
  readonly forgeId = "fake-forge";
  readonly model = "qwen3.5:4b";
  async *execute(req: ExecRequest): AsyncIterable<StreamChunk> {
    yield { token: `echo:${req.prompt.slice(0, 24)}`, done: false };
    yield { token: "", done: true };
  }
}
