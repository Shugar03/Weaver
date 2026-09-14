// apps/gateway — Hono, OpenAI-compatible SSE. S2/S3/S4 viven acá.
// Recibe dependencias, no las crea (testeabilidad). Idempotency-Key para fallback.
import { Hono } from "hono";
import { cors } from "hono/cors";
import { EtrScheduler } from "@weaver/scheduler";
import type { ForgeView } from "@weaver/scheduler";
import type { ForgeExec } from "@weaver/forge-exec";
import type { PaymentRequirements, PaymentVerifier } from "@weaver/settlement";
import type { Telemetry } from "@weaver/telemetry";

export type Paywall = { verifier: PaymentVerifier; payTo: string };
export type Chaos = { setDead: (dead: boolean) => void };
export type NodeInfo = { version: string; startedAt: number };
type Deps = {
  forges: () => ForgeView[];
  exec?: ForgeExec;
  paywall?: Paywall;
  chaos?: Chaos;
  telemetry?: Telemetry;
  node?: NodeInfo;
};

export function createApp(deps: Deps) {
  const app = new Hono();
  const scheduler = new EtrScheduler();

  // S7: CORS primero que todo (incluido paywall): el dashboard vive en otro origen.
  // Abierto por ser red local de demo; producción lo acota (declarado, no olvidado).
  app.use("/*", cors());

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

  // S8b: descubrimiento OpenAI (opencode/cursor/pi leen esto para listar modelos).
  app.get("/v1/models", (c) => {
    const ids = [...new Set(deps.forges().map((f) => f.model))];
    return c.json({ object: "list", data: ids.map((id) => ({ id, object: "model", owned_by: "weaver" })) });
  });

  // S7: kill switch del dashboard. Solo existe si el composition root da chaos.
  if (deps.chaos) {
    const chaos = deps.chaos;
    app.post("/v1/admin/kill", async (c) => {
      const body = await c.req.json<{ dead: boolean }>();
      const dead = body.dead === true;
      chaos.setDead(dead);
      return c.json({ dead });
    });
  }

  // S9a: historial de ejecuciones (in-memory, desde el boot) + estado del nodo.
  app.get("/v1/executions", (c) => {
    const raw = c.req.query("limit") ?? "20";
    const limit = Math.min(50, Math.max(1, Number.parseInt(raw, 10) || 20));
    return c.json(deps.telemetry?.recent(limit) ?? []);
  });

  const nodeVersion = deps.node?.version ?? "0.1.0-dev";
  const nodeStartedAt = deps.node?.startedAt ?? Date.now();
  app.get("/v1/status", (c) => c.json({ version: nodeVersion, uptimeMs: Date.now() - nodeStartedAt }));

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
    // S9a: telemetría de la ejecución real (quién sirvió + TTFT + ok).
    const t0 = Date.now();
    let firstAt = -1;
    const servedForge = () =>
      (exec as unknown as { lastForgeId?: string | null }).lastForgeId ?? exec.forgeId;
    const telRecord = (ok: boolean) =>
      deps.telemetry?.record({
        forgeId: servedForge(),
        model: body.model,
        ttftMs: firstAt < 0 ? Date.now() - t0 : firstAt - t0,
        ok,
        ts: Date.now(),
      });
    const stream = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder();
        // El cliente puede irse a mitad de stream (navegación, timeout, demo).
        // Enqueue sobre stream cancelado throwea: jamás debe voltear el proceso.
        const send = (s: string) => {
          try {
            controller.enqueue(enc.encode(s));
          } catch {
            /* cliente ido, se sigue drenando en silencio */
          }
        };
        try {
          for await (const chunk of exec.execute({ jobId: id, model: body.model, prompt })) {
            if (firstAt < 0) firstAt = Date.now();
            if (chunk.done) break;
            const data = JSON.stringify({
              id,
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: { content: chunk.token }, finish_reason: null }],
            });
            send(`data: ${data}\n\n`);
          }
          send("data: [DONE]\n\n");
          telRecord(true);
        } catch {
          // S3: muerte mid-stream → evento error explícito, jamás [DONE] trucho.
          send('data: {"error":"forge-failed"}\n\n');
          telRecord(false);
        }
        try {
          controller.close();
        } catch {
          /* ya cerrado por cancelación */
        }
      },
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
    });
  });

  return app;
}
