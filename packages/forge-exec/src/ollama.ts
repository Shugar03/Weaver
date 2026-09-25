// Adapter Ollama (backend MLX en Apple Silicon con Ollama ≥0.19).
// Habla OpenAI-compatible y devuelve el puerto ForgeExec. fetch inyectable
// para testear sin Ollama corriendo. Default: qwen3.5:4b en localhost:11434.
import type { ExecRequest, ForgeExec, StreamChunk } from "./ports.ts";

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export class OllamaMLXAdapter implements ForgeExec {
  readonly forgeId: string;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;

  constructor(opts: { forgeId?: string; model?: string; baseUrl?: string; fetchFn?: FetchFn; timeoutMs?: number } = {}) {
    this.forgeId = opts.forgeId ?? "ollama-local";
    this.model = opts.model ?? "qwen3:4b";
    this.baseUrl = (opts.baseUrl ?? "http://localhost:11434").replace(/\/$/, "");
    this.fetchFn = opts.fetchFn ?? ((url, init) => fetch(url, init));
    // Peor caso acotado: un forge colgado ya no deja el stream abierto para
    // siempre. En CPU sin GPU la generación es lenta: subir vía env si hace falta.
    this.timeoutMs = opts.timeoutMs ?? 300_000;
  }

  async *execute(req: ExecRequest): AsyncIterable<StreamChunk> {
    // Un solo AbortSignal: deadline propio + cancelación del cliente (req.signal).
    const signals = [AbortSignal.timeout(this.timeoutMs)];
    if (req.signal) signals.push(req.signal);
    const res = await this.fetchFn(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, messages: [{ role: "user", content: req.prompt }], stream: true }),
      signal: AbortSignal.any(signals),
    });
    if (!res.ok || !res.body) throw new Error(`ollama: http ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buf += dec.decode(value, { stream: !done });
      for (;;) {
        const i = buf.indexOf("\n\n");
        if (i < 0) break;
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        for (const line of frame.split("\n")) {
          const t = line.trim();
          if (!t.startsWith("data:")) continue;
          const data = t.slice(5).trim();
          if (data === "[DONE]") {
            yield { token: "", done: true };
            return;
          }
          // Frame parcial entre reads: imposible acá porque partimos por \n\n
          // y Ollama manda JSON de una línea; el catch es red de seguridad.
          try {
            const json = JSON.parse(data) as { choices?: { delta?: { content?: string } }[] };
            const content = json.choices?.[0]?.delta?.content ?? "";
            if (content) yield { token: content, done: false };
          } catch {
            throw new Error(`ollama: frame inválido: ${data.slice(0, 80)}`);
          }
        }
      }
      if (done) break;
    }
    yield { token: "", done: true };
  }
}
