// Adapter OpenAI-compatible (vLLM, llama.cpp-server, LM Studio, TGI…).
// Habla /v1/chat/completions con SSE — el dialecto que entienden los engines
// de producción. Es la puerta a modelos grandes: vLLM sirve AWQ/GPTQ/FP8 con
// tensor-parallel multi-GPU, y llama.cpp-server puede ser el front de un
// cluster RPC — ambos se ven acá como UN forge (una identidad, un proof).
//
// Diferencias con OllamaMLXAdapter:
//   - SSE data: frames (no NDJSON); [DONE] cierra.
//   - razonamiento llega como delta.reasoning_content (convención vLLM/
//     DeepSeek) → StreamChunk kind:"think".
//   - tool_calls llegan como DELTAS indexados — se acumulan por index y se
//     reportan completos en el frame done.
//   - usage viaja con stream_options.include_usage (prompt/completion tokens
//     medidos por el engine — stats honestos, no estimados).
// fetch inyectable para tests.
import type { ExecRequest, ForgeExec, StreamChunk, ToolCall } from "./ports.ts";

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

type OaiDelta = {
  role?: string;
  content?: string | null;
  reasoning_content?: string | null; // vLLM/DeepSeek: thinking del modelo
  tool_calls?: {
    index?: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }[];
};
type OaiFrame = {
  choices?: { delta?: OaiDelta; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

export class OpenAICompatAdapter implements ForgeExec {
  readonly forgeId: string;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;
  private readonly apiKey: string | undefined;

  constructor(opts: {
    forgeId?: string;
    model: string;
    baseUrl?: string;
    fetchFn?: FetchFn;
    timeoutMs?: number;
    apiKey?: string; // vLLM sirve sin key; endpoints managed la piden
  }) {
    this.forgeId = opts.forgeId ?? "openai-compat";
    this.model = opts.model;
    this.baseUrl = (opts.baseUrl ?? "http://localhost:8000").replace(/\/$/, "");
    this.fetchFn = opts.fetchFn ?? ((url, init) => fetch(url, init));
    this.timeoutMs = opts.timeoutMs ?? 300_000;
    this.apiKey = opts.apiKey;
  }

  // Liveness: /v1/models responde = engine alcanzable.
  async probe(): Promise<boolean> {
    try {
      const res = await this.fetchFn(`${this.baseUrl}/v1/models`, { method: "GET" });
      return res.ok;
    } catch {
      return false;
    }
  }

  // Residencia: el modelo figurando en /v1/models = servible ahora. vLLM
  // carga al boot (no hay cold-load por request como Ollama) — la lista es
  // la verdad de capacidad, no una promesa.
  async resident(): Promise<boolean> {
    try {
      const res = await this.fetchFn(`${this.baseUrl}/v1/models`, { method: "GET" });
      if (!res.ok) return false;
      const j = (await res.json()) as { data?: { id?: string }[] };
      return (j.data ?? []).some((m) => m.id === this.model);
    } catch {
      return false;
    }
  }

  async *execute(req: ExecRequest): AsyncIterable<StreamChunk> {
    let messages = req.messages?.length ? req.messages : [{ role: "user", content: req.prompt }];
    // Mid-stream resume (S45): prefijo como mensaje assistant — el modelo
    // continúa el turno desde ahí. Mismo contrato que OllamaMLXAdapter.
    if (req.resume?.prefix) {
      messages = [...messages, { role: "assistant", content: req.resume.prefix }];
    }
    const o = req.options;
    const res = await this.fetchFn(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: req.model,
        messages,
        stream: true,
        // usage en el último frame: tokens medidos por el engine — entran al
        // sample de telemetría como datos reales.
        stream_options: { include_usage: true },
        ...(o?.maxTokens !== undefined ? { max_tokens: o.maxTokens } : {}),
        ...(o?.temperature !== undefined ? { temperature: o.temperature } : {}),
        ...(o?.topP !== undefined ? { top_p: o.topP } : {}),
        ...(req.tools?.length ? { tools: req.tools } : {}),
      }),
      signal: AbortSignal.any(
        req.signal ? [AbortSignal.timeout(this.timeoutMs), req.signal] : [AbortSignal.timeout(this.timeoutMs)],
      ),
    });
    if (!res.ok || !res.body) throw new Error(`openai-compat: http ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    // tool_calls llegan por delta indexado — se juntan acá y salen completos
    // en el frame done (shape StreamChunk.toolCalls).
    const partialCalls = new Map<number, ToolCall & { argsBuf: string }>();
    let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
    let finished = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buf += dec.decode(value, { stream: !done });
      for (;;) {
        const i = buf.indexOf("\n");
        if (i < 0) break;
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        let json: OaiFrame;
        try {
          json = JSON.parse(data) as OaiFrame;
        } catch {
          throw new Error(`openai-compat: frame inválido: ${data.slice(0, 80)}`);
        }
        if (json.usage) usage = json.usage;
        const d = json.choices?.[0]?.delta;
        if (d?.reasoning_content) yield { token: d.reasoning_content, done: false, kind: "think" };
        if (d?.content) yield { token: d.content, done: false, kind: "content" };
        for (const tc of d?.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          const acc = partialCalls.get(idx) ?? { name: "", arguments: {}, argsBuf: "" };
          if (tc.function?.name) acc.name = tc.function.name;
          if (tc.function?.arguments) acc.argsBuf += tc.function.arguments;
          partialCalls.set(idx, acc);
        }
        const fr = json.choices?.[0]?.finish_reason;
        if (fr && !finished) {
          finished = true;
          // arguments llegan como string SSE — se parsean a objeto para el
          // shape interno (el gateway los re-stringifica al emitir).
          const toolCalls = [...partialCalls.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, c]) => {
              let args: Record<string, unknown> = {};
              try {
                args = JSON.parse(c.argsBuf || "{}") as Record<string, unknown>;
              } catch {
                /* args malformados del engine: van vacíos, el tool decide */
              }
              return { name: c.name, arguments: args };
            })
            .filter((c) => c.name);
          yield {
            token: "",
            done: true,
            ...(toolCalls.length ? { toolCalls } : {}),
            stats: {
              promptTokens: usage?.prompt_tokens,
              genTokens: usage?.completion_tokens,
            },
          };
        }
      }
      if (done) break;
    }
    if (!finished) yield { token: "", done: true };
  }
}
