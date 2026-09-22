// Module ForgeExec — Seam de ejecución. Dos Adapters => Seam real.
// El Scheduler nunca ve Ollama ni HTTP acá, solo este puerto.
// kind "think": token de razonamiento (qwen3 thinking) — se streamea igual que
// contenido para que el TTFT percibido sea el del PRIMER token, no el post-think.
export type StreamChunk = {
  token: string;
  done: boolean;
  kind?: "think" | "content";
  stats?: ExecStats;
  // El engine decidió llamar tools: llegan en el frame done (Ollama no las
  // streamea por partes). El caller ejecuta y re-envía con role:"tool".
  toolCalls?: ToolCall[];
};
// Tool call del engine — arguments ya viene parseado (objeto, no string).
export type ToolCall = { name: string; arguments: Record<string, unknown> };
// Métricas del engine en el frame final (Ollama las reporta gratis en done).
// Alimentan telemetría honesta: prefill vs decode separados (vocabulario Dynamo).
export type ExecStats = {
  promptTokens?: number;
  genTokens?: number;
  loadMs?: number;
  prefillMs?: number;
  decodeMs?: number;
};
// Opciones de generación pasadas por el cliente (whitelist OpenAI→engine).
export type ExecOptions = {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  think?: boolean; // false = el engine no razona (TTFT content mínimo)
  numCtx?: number; // ventana de contexto del engine (Ollama default 4096)
};
// Proof L0 (S23): recibo del forge — sha256 de SU output + firma ed25519.
// El contrato lo verifica en release: pago condicionado a entrega probada.
export type Proof = { forgeId: string; resultHash: Buffer; signature: Buffer };
// onForge: quién emitió el primer token. onProof: recibo firmado al completar.
// Ambos por request — sin estado compartido entre requests concurrentes.
// messages: si el cliente mandó el array OpenAI, viaja verbatim (roles + system
// intactos — mejor calidad y prefix-cache que el prompt aplastado).
export type ExecRequest = {
  jobId: string;
  model: string;
  prompt: string;
  messages?: { role: string; content: string; tool_calls?: unknown; name?: string }[];
  options?: ExecOptions;
  // Tools OpenAI-shaped, verbatim al engine (el puerto no conoce el schema).
  tools?: unknown[];
  onForge?: (forgeId: string) => void;
  // S27: un forge intentó y falló (pre-token o mid-stream). Alimenta el
  // circuit breaker del gateway — telemetría por request no ve intentos
  // absorbidos por failover, así que el dato tiene que nacer acá.
  onFail?: (forgeId: string) => void;
  onProof?: (proof: Proof) => void;
};

export interface ForgeExec {
  readonly forgeId: string;
  readonly model: string;
  execute(req: ExecRequest): AsyncIterable<StreamChunk>;
  // Liveness barato para el registry (S24): ausente = "no sé, suponé vivo".
  probe?(): Promise<boolean>;
  // Residencia del MODELO en el engine (≠ liveness): ausente = "suponé residente".
  // Un forge puede estar vivo pero COLD (keep_alive acotado, evicción por RAM).
  resident?(): Promise<boolean>;
}

// ---------- Media (imagen/video): jobs no-token ----------
// La difusión no streamea tokens: un job entra, un artefacto sale. Puerto
// separado de ForgeExec a propósito — forzarla al shape de chat sería mentira.
export type ImageRequest = {
  jobId: string;
  model: string;
  prompt: string;
  size?: string; // "1024x1024"
};
export type ImageResult = {
  forgeId: string;
  b64: string; // PNG base64
  ms: number; // latencia total medida en el adapter (load incluido si COLD)
};
export interface ImageExec {
  readonly forgeId: string;
  readonly model: string;
  generateImage(req: ImageRequest): Promise<ImageResult>;
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
    // Stats sintéticas pero de shape real — el billing/telemetría ejercitan
    // el mismo camino que con Ollama (prompt estimado + 1 token de echo).
    yield { token: "", done: true, stats: { promptTokens: Math.ceil(req.prompt.length / 4), genTokens: 1, decodeMs: 1 } };
  }
  async probe(): Promise<boolean> {
    return true;
  }
}
