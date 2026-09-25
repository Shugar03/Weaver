// S18 — cancelación del cliente llega al forge: cancelar el stream aborta
// el exec upstream (Ollama deja de generar). Antes: "se drenaba en silencio".
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.ts";
import type { ExecRequest, ForgeExec, StreamChunk } from "@weaver/forge-exec";

class HangingExec implements ForgeExec {
  readonly forgeId = "hanging";
  readonly model = "qwen3:4b";
  seenSignal?: AbortSignal;
  async *execute(req: ExecRequest): AsyncIterable<StreamChunk> {
    this.seenSignal = req.signal;
    yield { token: "arranqué", done: false };
    // Cuelga hasta que el cliente aborte (Ollama lento = esto).
    while (!req.signal?.aborted) {
      await new Promise((r) => setTimeout(r, 5));
    }
    yield { token: "", done: true };
  }
}

const chat = () => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "qwen3:4b", messages: [{ role: "user", content: "hola" }], stream: true }),
});

describe("S18 cancel → abort upstream", () => {
  it("cancelar el response aborta el signal del exec", async () => {
    const exec = new HangingExec();
    const app = createApp({ forges: () => [], exec });
    const res = await app.request("/v1/chat/completions", chat());
    assert.equal(res.status, 200);
    const reader = res.body!.getReader();
    await reader.read(); // primer chunk recibido, exec corriendo
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 30)); // dejar propagar el abort
    assert.equal(exec.seenSignal?.aborted, true);
  });
});
