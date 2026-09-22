// apps/gateway — Hono, OpenAI-compatible SSE. S2/S3/S4 viven acá.
// Recibe dependencias, no las crea (testeabilidad). Idempotency-Key para fallback.
import { Hono, type Context, type Next } from "hono";
import { cors } from "hono/cors";
import { EtrScheduler } from "@weaver/scheduler";
import type { ForgeView } from "@weaver/scheduler";
import type { ForgeExec, Proof } from "@weaver/forge-exec";
import type { PaymentRequirements, PaymentVerifier } from "@weaver/settlement";
import type { SettleReceipt } from "@weaver/settlement";
import type { ApiKeys } from "@weaver/api-keys";
import type { Telemetry } from "@weaver/telemetry";

export type Paywall = { verifier: PaymentVerifier; payTo: string };
export type Chaos = { setDead: (dead: boolean) => void };
export type NodeInfo = { version: string; startedAt: number };
type Deps = {
  forges: () => ForgeView[] | Promise<ForgeView[]>; // async = forma canónica (un registry real lo es)
  exec?: ForgeExec;
  paywall?: Paywall;
  chaos?: Chaos;
  telemetry?: Telemetry;
  node?: NodeInfo;
  apiKeys?: ApiKeys;
  settlement?: { settleJob(resultHash: Buffer, forgeSig: Buffer): Promise<SettleReceipt> }; // S17b+S22/23: ausente = sin liquidación (dev)
  rateLimit?: { rpm: number }; // S15a: ausente = abierto (dev)
  corsOrigins?: string[]; // S15a: ausente = abierto (dev); presente = allowlist
};

export function createApp(deps: Deps) {
  const app = new Hono<{
    Variables: { keyId?: string; keyOwner?: string; paymentHeader?: string; paymentReqs?: PaymentRequirements };
  }>();
  const scheduler = new EtrScheduler();

  // S21: Idempotency-Key — el retry del cliente re-ejecuta pero no re-cobra.
  // Cachea la Promise (no el resultado): requests concurrentes con la misma key
  // comparten el settle en vuelo. Fallo → se borra y el retry reintenta de verdad.
  const settleCache = new Map<string, Promise<SettleReceipt>>();
  const settleOnce = (
    s: { settleJob(h: Buffer, sig: Buffer): Promise<SettleReceipt> },
    key: string,
    hash: Buffer,
    sig: Buffer,
  ) => {
    const hit = settleCache.get(key);
    if (hit) return hit;
    const p = s.settleJob(hash, sig);
    p.catch(() => settleCache.delete(key));
    settleCache.set(key, p);
    if (settleCache.size > 10_000) {
      const first = settleCache.keys().next().value;
      if (first !== undefined) settleCache.delete(first);
    }
    return p;
  };

  // S11: admin solo operador. Sin apiKeys (dev local), pasa todo (opt-in como el resto).
  const requireOperator = async (c: Context, next: Next) => {
    if (!deps.apiKeys) {
      await next();
      return;
    }
    if (c.get("keyOwner") !== "operator") {
      if (!c.get("keyId")) return c.json({ error: "falta autenticación", code: "unauthorized" }, 401);
      return c.json({ error: "requiere operador", code: "forbidden" }, 403);
    }
    await next();
  };

  // S7: CORS primero que todo (incluido paywall): el dashboard vive en otro origen.
  // Abierto por ser red local de demo; producción lo acota (declarado, no olvidado).
  // S15a: con corsOrigins solo esos orígenes reciben ACAO.
  app.use("/*", cors(deps.corsOrigins?.length ? { origin: deps.corsOrigins } : undefined));

  // S10a: API keys estilo provider. Válida abre e identifica (metering);
  // trucha → 401; ausente → sigue al paywall. Sin apiKeys en Deps, todo pasa.
  if (deps.apiKeys) {
    const keys = deps.apiKeys;
    app.use("/v1/*", async (c, next) => {
      const auth = c.req.header("authorization");
      if (!auth?.startsWith("Bearer ")) {
        await next();
        return;
      }
      const info = await keys.verify(auth.slice("Bearer ".length));
      if (!info) return c.json({ error: "API key inválida", code: "invalid_key" }, 401);
      c.set("keyId", info.id);
      c.set("keyOwner", info.owner);
      await next();
    });
  }

  // S15a: rate limit por caller (keyId o IP), barato y antes que paywall/exec.
  // Ráfaga corta sí, abuso → 429 con código, jamás 500 ni caída.
  if (deps.rateLimit) {
    const { rpm } = deps.rateLimit;
    const buckets = new Map<string, { window: number; count: number }>();
    app.use("/v1/*", async (c, next) => {
      const caller =
        c.get("keyId") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "anon";
      const window = Math.floor(Date.now() / 60000);
      if (buckets.size > 5000) {
        for (const [k, v] of buckets) if (v.window < window) buckets.delete(k);
      }
      const b = buckets.get(caller);
      if (b && b.window === window) {
        b.count++;
        if (b.count > rpm)
          return c.json({ error: "demasiados requests", code: "rate_limited" }, 429);
      } else {
        buckets.set(caller, { window, count: 1 });
      }
      await next();
    });
  }

  // S4: paywall x402 opt-in. Sin paywall en Deps, todo abierto (dev/S2).
  // S15a: se paga el cómputo (POST jobs/chat), no el descubrimiento (GETs abiertos
  // para dashboard y agentes aunque el paywall esté ON).
  if (deps.paywall) {
    const { verifier, payTo } = deps.paywall;
    app.use("/v1/*", async (c, next) => {
      const paidRoute =
        c.req.method === "POST" &&
        (c.req.path === "/v1/jobs" || c.req.path === "/v1/chat/completions");
      if (!paidRoute) {
        await next();
        return;
      }
      const requirements: PaymentRequirements = { scheme: "exact", network: "stellar:testnet", price: "$0.01", payTo };
      if (c.get("keyId")) {
        await next(); // key válida: cliente identificado (allowlist dev), el cobro va por otro canal
        return;
      }
      const header = c.req.header("x-payment");
      const ok = header ? await verifier.verify(header, requirements) : false;
      if (!ok) return c.json({ x402Version: 2, error: "pago requerido", accepts: [requirements] }, 402);
      // S23: verify autoriza; el settle (cobro real) corre post-serve en el handler.
      c.set("paymentHeader", header);
      c.set("paymentReqs", requirements);
      await next();
    });
  }

  app.get("/v1/forges", async (c) => c.json(await deps.forges()));

  // S8b: descubrimiento OpenAI (opencode/cursor/pi leen esto para listar modelos).
  app.get("/v1/models", async (c) => {
    const ids = [...new Set((await deps.forges()).map((f) => f.model))];
    return c.json({ object: "list", data: ids.map((id) => ({ id, object: "model", owned_by: "weaver" })) });
  });

  // S10a: administración de keys. Solo existe si hay apiKeys (operador local).
  if (deps.apiKeys) {
    const keys = deps.apiKeys;
    app.post("/v1/admin/keys", requireOperator, async (c) => {
      const body = await c.req.json<{ owner: string }>();
      if (!body.owner) return c.json({ error: "falta owner" }, 400);
      const { id, secret } = await keys.issue(body.owner);
      return c.json({ id, secret }, 201);
    });
    app.get("/v1/admin/keys", requireOperator, async (c) => c.json(await keys.list()));
    app.post("/v1/admin/keys/:id/revoke", requireOperator, async (c) => {
      const id = c.req.param("id");
      if (!id) return c.json({ error: "key inexistente" }, 404);
      const ok = await keys.revoke(id);
      if (!ok) return c.json({ error: "key inexistente" }, 404);
      return c.json({ revoked: true });
    });
  }

  // S7: kill switch del dashboard. Solo existe si el composition root da chaos.
  if (deps.chaos) {
    const chaos = deps.chaos;
    app.post("/v1/admin/kill", requireOperator, async (c) => {
      const body = await c.req.json<{ dead: boolean }>();
      const dead = body.dead === true;
      chaos.setDead(dead);
      return c.json({ dead });
    });
  }

  // S9a: historial de ejecuciones (in-memory, desde el boot) + estado del nodo.
  app.get("/v1/executions", async (c) => {
    const raw = c.req.query("limit") ?? "20";
    const limit = Math.min(50, Math.max(1, Number.parseInt(raw, 10) || 20));
    return c.json((await deps.telemetry?.recent(limit)) ?? []);
  });

  // S17a: metering por key (o nodo). spent = ok × $0.01 (JOB_PRICE_USDC).
  app.get("/v1/usage", async (c) => {
    const keyId = c.req.query("keyId") || undefined;
    return c.json(
      (await deps.telemetry?.usage(keyId)) ?? { jobs: 0, ok: 0, okRate: 0, spentUSDC: 0 },
    );
  });

  const nodeVersion = deps.node?.version ?? "0.1.0-dev";
  const nodeStartedAt = deps.node?.startedAt ?? Date.now();
  app.get("/v1/status", (c) => c.json({ version: nodeVersion, uptimeMs: Date.now() - nodeStartedAt }));

  app.post("/v1/jobs", async (c) => {
    const body = await c.req.json<{ model: string }>();
    // S19: modelo que nadie sirve → 404 con código, jamás 500.
    const forges = (await deps.forges()).filter((f) => f.model === body.model);
    if (forges.length === 0) {
      return c.json({ error: "modelo sin forges", code: "unknown_model" }, 404);
    }
    const d = scheduler.select({ id: crypto.randomUUID(), model: body.model }, forges);
    return c.json({ forge: d.forgeId, etr_ms: d.etrMs, reason: d.reason });
  });

  // S2: SSE mínimo OpenAI-compatible. El exec streamea, el gateway solo enmarca.
  app.post("/v1/chat/completions", async (c) => {
    if (!deps.exec) return c.json({ error: "sin forge de ejecución" }, 503);
    const body = await c.req.json<{ model: string; messages: { role: string; content: string }[] }>();
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const prompt = messages.map((m) => m.content).join("\n");
    // S11: caps anti-DoS (un request gigante ahoga Ollama). 413 con código, jamás 500 ni OOM.
    if (messages.length > 20 || prompt.length > 8000) {
      return c.json({ error: "prompt demasiado grande", code: "prompt_too_large" }, 413);
    }
    // S19: el modelo pedido debe existir en la fleet — si no, 404 antes de
    // abrir stream ni tocar un forge (nada de servir otro modelo en silencio).
    if (!(await deps.forges()).some((f) => f.model === body.model)) {
      return c.json({ error: "modelo sin forges", code: "unknown_model" }, 404);
    }
    const exec = deps.exec;
    const id = `chatcmpl-${crypto.randomUUID()}`;
    // S9a/S19: telemetría de la ejecución real — onForge reporta por request
    // quién sirvió (sin espiar internals ni estado compartido entre requests).
    const t0 = Date.now();
    let firstAt = -1;
    let servedForgeId: string | null = null;
    // S23: el forge firma su output (Proof L0) — el contrato lo exige en release.
    let proof: Proof | null = null;
    const telRecord = (ok: boolean) => {
      const base = {
        forgeId: servedForgeId ?? exec.forgeId,
        model: body.model,
        ttftMs: firstAt < 0 ? Date.now() - t0 : firstAt - t0,
        ok,
        ts: Date.now(),
        keyId: c.get("keyId"),
      };
      // S17b: lo fallido no se paga (solo se registra). Lo OK liquida en background:
      // fire-and-forget a propósito — settle lento o caído jamás frena ni voltea requests.
      const payerHeader = c.get("paymentHeader");
      const payerReqs = c.get("paymentReqs");
      if (!ok || (!deps.settlement && !payerHeader)) {
        deps.telemetry?.record(base).catch(() => {});
        return;
      }
      const settlement = deps.settlement;
      const idemKey = c.req.header("idempotency-key");
      const paywall = deps.paywall;
      const servedProof = proof;
      void (async () => {
        // S23: pata cliente — x402 settle ejecuta el pago YA verificado.
        let payerTx: string | undefined;
        let payerOk = true;
        if (payerHeader && payerReqs && paywall) {
          const s = await paywall.verifier.settle(payerHeader, payerReqs);
          payerOk = s.success;
          payerTx = s.txHash;
        }
        // S17b+S22/23: pata worker — escrow operador→worker exige result_hash
        // + firma del forge. Sin proof no hay pago (trabajo no probado).
        if (!settlement) {
          await deps.telemetry
            ?.record({ ...base, settle: { payerTx, status: payerOk ? "settled" : "failed" } })
            .catch(() => {});
          return;
        }
        if (!servedProof) {
          await deps.telemetry
            ?.record({ ...base, settle: { payerTx, status: "failed" } })
            .catch(() => {});
          return;
        }
        try {
          const r = idemKey
            ? await settleOnce(settlement, idemKey, servedProof.resultHash, servedProof.signature)
            : await settlement.settleJob(servedProof.resultHash, servedProof.signature);
          await deps.telemetry?.record({
            ...base,
            settle: { payerTx, fundTx: r.fundTx, releaseTx: r.releaseTx, status: payerOk ? "settled" : "failed" },
          });
        } catch {
          await deps.telemetry
            ?.record({ ...base, settle: { payerTx, status: "failed" } })
            .catch(() => {});
        }
      })();
    };
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
          for await (const chunk of exec.execute({
            jobId: id,
            model: body.model,
            prompt,
            onForge: (fid) => {
              servedForgeId = fid;
            },
            onProof: (p) => {
              proof = p;
            },
          })) {
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
