// Targets bench: gateway Weaver (con orquestación) vs Ollama directo (baseline).
// Misma forma OpenAI en ambos; la diferencia mide el costo de nuestra stack.
import type { ChatTarget, Chunk } from "./types.ts";
import { sseDataPayloads } from "./sse.ts";

async function* openAIStream(url: string, body: unknown): AsyncIterable<Chunk> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  for await (const data of sseDataPayloads(res)) {
    if (data === "[DONE]") {
      yield { token: "", done: true };
      return;
    }
    let json: { error?: unknown; choices?: { delta?: { content?: string } }[] };
    try {
      json = JSON.parse(data) as typeof json;
    } catch {
      continue; // frame no-JSON: se ignora, no se mide como token
    }
    if (typeof json.error === "string" && json.error) throw new Error(`bench: forge ${json.error}`);
    const content = json.choices?.[0]?.delta?.content ?? "";
    if (content) yield { token: content, done: false };
  }
  yield { token: "", done: true };
}

export class GatewayTarget implements ChatTarget {
  readonly name = "weaver-gateway";
  private baseUrl: string;
  private model: string;

  constructor(baseUrl = "http://localhost:3001", model = "qwen3:4b") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.model = model;
  }

  chat(prompt: string): AsyncIterable<Chunk> {
    return openAIStream(`${this.baseUrl}/v1/chat/completions`, {
      model: this.model,
      messages: [{ role: "user", content: prompt }],
      stream: true,
    });
  }
}

export class DirectTarget implements ChatTarget {
  readonly name = "ollama-direct";
  private baseUrl: string;
  private model: string;

  constructor(baseUrl = "http://localhost:11434", model = "qwen3:4b") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.model = model;
  }

  chat(prompt: string): AsyncIterable<Chunk> {
    return openAIStream(`${this.baseUrl}/v1/chat/completions`, {
      model: this.model,
      messages: [{ role: "user", content: prompt }],
      stream: true,
    });
  }
}
