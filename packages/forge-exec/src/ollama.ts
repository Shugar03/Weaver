// Adapter Ollama (backend MLX en Apple Silicon con Ollama ≥0.19).
// Habla /api/chat nativo (NDJSON) — no el shim OpenAI: es el único camino donde
// Ollama respeta `think` (streaming del razonamiento de qwen3 en vez de ocultarlo),
// `keep_alive` (modelo residente → load_time = 0 siempre) y devuelve métricas
// (prompt_eval_count/eval_count/durations) en el frame final.
// Default: qwen3.5:4b en localhost:11434. fetch inyectable para tests.
import type { ExecRequest, ForgeExec, StreamChunk, ToolCall } from "./ports.ts";

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

// Frame NDJSON de /api/chat: message.thinking + message.content separados,
// y al final done:true con métricas del engine en nanosegundos.
type OllamaFrame = {
  message?: {
    role?: string;
    content?: string;
    thinking?: string;
    tool_calls?: { function?: { name?: string; arguments?: Record<string, unknown> } }[];
  };
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
  load_duration?: number;
  prompt_eval_duration?: number;
  eval_duration?: number;
};

export class OllamaMLXAdapter implements ForgeExec {
  readonly forgeId: string;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;

  private readonly keepAlive: number;

  constructor(opts: { forgeId?: string; model?: string; baseUrl?: string; fetchFn?: FetchFn; keepAlive?: number } = {}) {
    this.forgeId = opts.forgeId ?? "ollama-local";
    this.model = opts.model ?? "qwen3:4b";
    this.baseUrl = (opts.baseUrl ?? "http://localhost:11434").replace(/\/$/, "");
    this.fetchFn = opts.fetchFn ?? ((url, init) => fetch(url, init));
    // -1 = residente forever; N segundos = Ollama lo descarga tras N idle.
    // En 16GB, un segundo LLM residente compite con el forge de imagen.
    this.keepAlive = opts.keepAlive ?? -1;
  }

  // S24: liveness del ENGINE — /v1/models responde = el forge es alcanzable
  // (puede cargar el modelo on-demand; un modelo descargado ≠ forge muerto).
  async probe(): Promise<boolean> {
    try {
      const res = await this.fetchFn(`${this.baseUrl}/v1/models`, { method: "GET" });
      return res.ok;
    } catch {
      return false;
    }
  }

  // Residencia real del MODELO — /api/ps lista los cargados. Con keep_alive
  // acotado o presión de RAM, Ollama descarga entre jobs: el forge sigue vivo
  // (probe=true) pero COLD — el scheduler cobra load_time, no un forge "muerto".
  async resident(): Promise<boolean> {
    try {
      const res = await this.fetchFn(`${this.baseUrl}/api/ps`, { method: "GET" });
      if (!res.ok) return false;
      const j = (await res.json()) as { models?: { name?: string; model?: string }[] };
      const want = this.model.includes(":") ? this.model : `${this.model}:latest`;
      return (j.models ?? []).some((m) => (m.model ?? m.name ?? "") === want || (m.name ?? "") === want);
    } catch {
      return false;
    }
  }

  async *execute(req: ExecRequest): AsyncIterable<StreamChunk> {
    // messages verbatim si el cliente los mandó (system/roles intactos);
    // si no, el prompt como un solo user message (camino histórico).
    const messages = req.messages?.length ? req.messages : [{ role: "user", content: req.prompt }];
    const o = req.options;
    const res = await this.fetchFn(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // S19: el modelo es el del request (el scheduler ya validó que la fleet lo
      // sirve). `this.model` queda como label de qué declara servir este forge.
      body: JSON.stringify({
        model: req.model,
        messages,
        stream: true,
        // keep_alive -1 = nunca descargar (mata el load_time post-idle);
        // N segundos = auto-descarga al estar idle — libera RAM para otros forges.
        keep_alive: this.keepAlive,
        // think default true + se streamea: TTFT percibido ≈ primer token real.
        think: o?.think ?? true,
        ...(req.tools?.length ? { tools: req.tools } : {}),
        options: {
          ...(o?.maxTokens !== undefined ? { num_predict: o.maxTokens } : {}),
          ...(o?.temperature !== undefined ? { temperature: o.temperature } : {}),
          ...(o?.topP !== undefined ? { top_p: o.topP } : {}),
          ...(o?.numCtx !== undefined ? { num_ctx: o.numCtx } : {}),
        },
      }),
    });
    if (!res.ok || !res.body) throw new Error(`ollama: http ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const toolCalls: ToolCall[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buf += dec.decode(value, { stream: !done });
      for (;;) {
        const i = buf.indexOf("\n");
        if (i < 0) break;
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let json: OllamaFrame;
        try {
          json = JSON.parse(line) as OllamaFrame;
        } catch {
          throw new Error(`ollama: frame inválido: ${line.slice(0, 80)}`);
        }
        const msg = json.message;
        if (msg?.thinking) yield { token: msg.thinking, done: false, kind: "think" };
        if (msg?.content) yield { token: msg.content, done: false, kind: "content" };
        for (const tc of msg?.tool_calls ?? []) {
          if (tc.function?.name) toolCalls.push({ name: tc.function.name, arguments: tc.function.arguments ?? {} });
        }
        if (json.done) {
          // Métricas del engine (ns → ms): prefill vs decode separados.
          yield {
            token: "",
            done: true,
            ...(toolCalls.length ? { toolCalls } : {}),
            stats: {
              promptTokens: json.prompt_eval_count,
              genTokens: json.eval_count,
              loadMs: json.load_duration !== undefined ? Math.round(json.load_duration / 1e6) : undefined,
              prefillMs:
                json.prompt_eval_duration !== undefined ? Math.round(json.prompt_eval_duration / 1e6) : undefined,
              decodeMs: json.eval_duration !== undefined ? Math.round(json.eval_duration / 1e6) : undefined,
            },
          };
          return;
        }
      }
      if (done) break;
    }
    yield { token: "", done: true };
  }
}
