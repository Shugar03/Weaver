// Composition root local: forges reales + Ollama. Sin paywall (bench/dev).
// Uso: `node apps/gateway/src/serve.ts` (dejar corriendo en una terminal).
import { serve } from "@hono/node-server";
import { createApp } from "./index.ts";
import { FailoverForgeExec, OllamaMLXAdapter } from "@weaver/forge-exec";

const app = createApp({
  forges: () => [
    { forgeId: "ollama-local", model: "qwen3:4b", hot: true, rttMs: 5, queueMs: 0, loadTimeMs: 0, price: 0, reliability: 1 },
  ],
  exec: new FailoverForgeExec([new OllamaMLXAdapter({ model: "qwen3:4b" })]),
});

const port = Number(process.env.PORT ?? 3001);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`weaver-gateway en http://localhost:${info.port}`);
});
