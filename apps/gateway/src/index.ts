// apps/gateway — Hono, OpenAI-compatible SSE. S2/S3/S4 viven acá.
// Recibe dependencias, no las crea (testeabilidad). Idempotency-Key para fallback.
import { Hono } from "hono";
import { EtrScheduler } from "@weaver/scheduler";
import type { ForgeView } from "@weaver/scheduler";
import type { ForgeExec } from "@weaver/forge-exec";
import type { PaymentRequirements, PaymentVerifier } from "@weaver/settlement";

export type Paywall = { verifier: PaymentVerifier; payTo: string };
type Deps = { forges: () => ForgeView[]; exec?: ForgeExec; paywall?: Paywall };

export function createApp(deps: Deps) {
  const app = new Hono();
  const scheduler = new EtrScheduler();

  // S4: paywall x402 opt-in. Sin paywall en Deps, todo abierto (dev/S2).
  if (deps.paywall) {
    const { verifier, payTo } = deps.paywall;
    app.use("/v1/*", async (c, next) => {
      const header = c.req.header("x-payment");
      const requirements: PaymentRequirements = { scheme: "exact", network: "stellar:testnet", price: "$0.01", payTo };
      const ok = header ? await verifier.verify(header, requirements) : false;
      if (!ok) return c.json({ x402Version: 2, error: "pago requerido", accepts: [requirements] }, 402);
      await next();
    });
  }

  app.get("/v1/forges", (c) => c.json(deps.forges()));

  app.post("/v1/jobs", async (c) => {
    const body = await c.req.json<{ model: string }>();
    const forges = deps.forges().filter((f) => f.model === body.model);
    const d = scheduler.select({ id: crypto.randomUUID(), model: body.model }, forges);
    return c.json({ forge: d.forgeId, etr_ms: d.etrMs, reason: d.reason });
  });

  // S2: SSE mínimo OpenAI-compatible. El exec streamea, el gateway solo enmarca.
  app.post("/v1/chat/completions", async (c) => {
    if (!deps.exec) return c.json({ error: "sin forge de ejecución" }, 503);
    const body = await c.req.json<{ model: string; messages: { role: string; content: string }[] }>();
    const prompt = body.messages.map((m) => m.content).join("\n");
    const exec = deps.exec;
    const id = `chatcmpl-${crypto.randomUUID()}`;
    const stream = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder();
        try {
          for await (const chunk of exec.execute({ jobId: id, model: body.model, prompt })) {
            if (chunk.done) break;
            const data = JSON.stringify({
              id,
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: { content: chunk.token }, finish_reason: null }],
            });
            controller.enqueue(enc.encode(`data: ${data}\n\n`));
          }
          controller.enqueue(enc.encode("data: [DONE]\n\n"));
        } catch {
          // S3: muerte mid-stream → evento error explícito, jamás [DONE] trucho.
          controller.enqueue(enc.encode('data: {"error":"forge-failed"}\n\n'));
        }
        controller.close();
      },
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
    });
  });

  return app;
}
