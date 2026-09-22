// apps/gateway — Hono, OpenAI-compatible SSE. S2/S3/S4 viven acá.
// Recibe dependencias, no las crea (testeabilidad). Idempotency-Key para fallback.
import { Hono, type Context, type Next } from "hono";
import { cors } from "hono/cors";
import { DEAD_QUEUE_MS, EtrScheduler } from "@weaver/scheduler";
import { imageDims } from "@weaver/forge-net";
import type { ForgeView } from "@weaver/scheduler";
import type { ExecStats, ForgeExec, ImageExec, Proof } from "@weaver/forge-exec";
import type { PaymentRequirements, PaymentVerifier } from "@weaver/settlement";
import type { SettleReceipt } from "@weaver/settlement";
import type { ApiKeys } from "@weaver/api-keys";
import type { AccountStore, CreditLedger, PricingBook } from "@weaver/accounts";
import { depositMemoFor } from "@weaver/accounts";
import type { Telemetry } from "@weaver/telemetry";
import type { AgentHost } from "./agent.ts";
import { extractDocText } from "./agent.ts";

export type Paywall = { verifier: PaymentVerifier; payTo: string };
// setDead(forgeId, dead): true = el forge existe y quedó en ese estado;
// false = el root no controla ese forgeId (404 honesto). forgeId undefined =
// el default que decida el composition root (serve.ts: el primario).
export type Chaos = { setDead: (forgeId: string | undefined, dead: boolean) => boolean };
export type NodeInfo = { version: string; startedAt: number };
// S27: el breaker ve los intentos fallidos por forge (onFail) y los éxitos
// (onForge). Sin él, un forge roto con probe vivo mantiene ETR bueno y cada
// request paga un intento fallido antes del failover.
export type Breaker = { fail(forgeId: string): void; ok(forgeId: string): void };
type Deps = {
  forges: () => ForgeView[] | Promise<ForgeView[]>; // async = forma canónica (un registry real lo es)
  exec?: ForgeExec;
  paywall?: Paywall;
  chaos?: Chaos;
  telemetry?: Telemetry;
  node?: NodeInfo;
  apiKeys?: ApiKeys;
  settlement?: { settleJob(resultHash: Buffer, forgeSig: Buffer, worker?: string, stats?: { genTokens?: number }): Promise<SettleReceipt> }; // S17b+S22/23: ausente = sin liquidación (dev)
  // S34: payout per-forge — resuelve la pubkey registrada del forge que sirvió
  // (registry remoto). Embedded → undefined → settlement usa su worker default.
  forgePubkeyOf?: (forgeId: string) => string | undefined;
  // S37: verificación del proof L0 por-job (ed25519 vs pubkey del forge).
  // Forges remotos: TODA firma se verifica antes de pagar — la attestation
  // prueba una vez, esto prueba siempre. Embedded: la verificación on-chain
  // del contrato alcanza (firma con WORKER_SECRET local, misma entidad).
  verifyProof?: (pubkey: string, hash: Buffer, sig: Buffer) => boolean;
  // S38: audit probabilístico post-job — re-attestation del forge que sirvió.
  // Fire-and-forget: la implementación decide rate y consecuencias.
  audit?: (forgeId: string, model: string) => void;
  rateLimit?: { rpm: number }; // S15a: ausente = abierto (dev)
  corsOrigins?: string[]; // S15a: ausente = abierto (dev); presente = allowlist
  agent?: AgentHost; // capabilities server-side del Weaver Agent (MCP, web, skills, persona)
  imageExecs?: Record<string, ImageExec>; // jobs de imagen: mismo scheduler, puerto distinto (no tokens)
  media?: Map<string, { buf: Buffer; mime: string }>; // artefactos generados, servidos en /v1/media/:id
  breaker?: Breaker; // S27: ausente = sin circuit breaker (tests/dev aislado)
  // S32: nonces de handshake forge (ADR-0005). Ausente = sin forges remotos.
  challenges?: { issue(): { nonce: string; expiresAt: number } };
  // S47 (ADR-0007): cuentas de usuario + billing prepago. Todas opt-in —
  // sin accounts/ledger el gateway se comporta exactamente como hoy (A5).
  accounts?: AccountStore;
  ledger?: CreditLedger;
  pricing?: PricingBook;
  // Challenges de login wallet (firma de "weaver-login:<nonce>") — instancia
  // separada del NonceStore de forges. Ausente = login por mgmt token solo.
  meChallenges?: { issue(): { nonce: string; expiresAt: number }; consume(nonce: string): boolean };
  verifyWalletSig?: (pubkey: string, msg: Buffer, sig: Buffer) => boolean;
  // Deposit address pública del operador — la muestra el panel (Overview).
  depositAddress?: string;
  // S48: metadata declarada por modelo para el marketplace (env MODEL_CATALOG).
  // Solo lo que el operador declara — nada se infiere ni se inventa.
  catalog?: Record<string, CatalogMeta>;
};

export type CatalogMeta = {
  name?: string;
  description?: string;
  context?: number; // tokens de context window declarados
  features?: string[]; // tools | reasoning | vision | image | json | audio | video
  docs?: string; // URL de documentación del modelo
};

export function createApp(deps: Deps) {
  const app = new Hono<{
    Variables: { keyId?: string; keyOwner?: string; accountId?: string; paymentHeader?: string; paymentReqs?: PaymentRequirements };
  }>();
  const scheduler = new EtrScheduler();

  // S21: Idempotency-Key — el retry del cliente re-ejecuta pero no re-cobra.
  // Cachea la Promise (no el resultado): requests concurrentes con la misma key
  // comparten el settle en vuelo. Fallo → se borra y el retry reintenta de verdad.
  // I2 (ADR-0006): el dedup es por RESULTADO (key+hash), no por request —
  // un retry que re-ejecuta y produce otro output es trabajo distinto que
  // se paga al forge que lo sirvió (la key sola suprimía pagos legítimos).
  const settleCache = new Map<string, Promise<SettleReceipt>>();
  const settleOnce = (
    s: { settleJob(h: Buffer, sig: Buffer, worker?: string, stats?: { genTokens?: number }): Promise<SettleReceipt> },
    key: string,
    hash: Buffer,
    sig: Buffer,
    worker?: string,
    stats?: { genTokens?: number },
  ) => {
    const cacheKey = `${key}:${hash.toString("hex")}`;
    const hit = settleCache.get(cacheKey);
    if (hit) return hit;
    const p = s.settleJob(hash, sig, worker, stats);
    p.catch(() => settleCache.delete(cacheKey));
    settleCache.set(cacheKey, p);
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
      // S47: /v1/me/* y /v1/accounts tienen su propia auth (mgmt/session
      // tokens también empiezan con wvr_ — el middleware de api-keys las
      // rechazaría con 401 falso antes de llegar al requireAccount).
      if (c.req.path.startsWith("/v1/me") || c.req.path === "/v1/accounts") {
        await next();
        return;
      }
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
    // Solo modelos de texto: /v1/models es el contrato OpenAI de chat — un
    // modelo de imagen acá haría que un cliente intente chatear con difusión.
    const ids = [...new Set((await deps.forges()).filter((f) => (f.capability ?? "text") === "text").map((f) => f.model))];
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

  // S47 (ADR-0007): cuentas de usuario — self-serve keys + créditos prepagos.
  // Auth dual: Bearer wvr_acct_ (management token) o wvr_sess_ (sesión de
  // firma wallet). Todo lo de /v1/me/* pasa por requireAccount — una cuenta
  // jamás ve ni toca los recursos de otra (A4).
  if (deps.accounts) {
    const accounts = deps.accounts;
    const ledger = deps.ledger;
    const keys = deps.apiKeys;

    const requireAccount = async (c: Context, next: Next) => {
      const auth = c.req.header("authorization");
      const token = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : "";
      const account = token.startsWith("wvr_acct_")
        ? await accounts.byMgmtToken(token)
        : token.startsWith("wvr_sess_")
          ? await accounts.bySession(token)
          : null;
      if (!account) return c.json({ error: "autenticación de cuenta requerida", code: "unauthorized" }, 401);
      c.set("accountId", account.id);
      await next();
    };

    app.post("/v1/accounts", async (c) => {
      const { account, mgmtToken } = await accounts.create();
      return c.json({ accountId: account.id, mgmtToken, depositMemo: depositMemoFor(account) }, 201);
    });

    // Login wallet: challenge → firma "weaver-login:<nonce>" → sesión.
    // El nonce es single-use + 60s TTL (replay no autentica). Si la wallet
    // no tiene cuenta, se crea on-first-login atada al pubkey.
    if (deps.meChallenges && deps.verifyWalletSig) {
      const challenges = deps.meChallenges;
      const verify = deps.verifyWalletSig;
      const verifyLogin = async (pubkey: string, nonce: string, sigHex: string): Promise<boolean> => {
        if (!challenges.consume(nonce)) return false;
        try {
          return verify(pubkey, Buffer.from(`weaver-login:${nonce}`), Buffer.from(sigHex, "hex"));
        } catch {
          return false;
        }
      };

      app.post("/v1/me/challenge", (c) => c.json(challenges.issue()));

      app.post("/v1/me/session", async (c) => {
        const body = await c.req
          .json<{ pubkey?: string; nonce?: string; signature?: string }>()
          .catch((): { pubkey?: string; nonce?: string; signature?: string } => ({}));
        if (!body.pubkey || !body.nonce || !body.signature) {
          return c.json({ error: "faltan pubkey/nonce/signature", code: "bad_request" }, 400);
        }
        if (!(await verifyLogin(body.pubkey, body.nonce, body.signature))) {
          return c.json({ error: "firma inválida o nonce usado", code: "unauthorized" }, 401);
        }
        const account = (await accounts.byWallet(body.pubkey)) ?? (await accounts.createForWallet(body.pubkey));
        const { token, expiresAt } = await accounts.issueSession(account.id);
        return c.json({ sessionToken: token, accountId: account.id, expiresAt });
      });

      // Link de wallet a una cuenta existente (autenticada). La firma prueba
      // control de la wallet; una wallet ya atada a OTRA cuenta → 409.
      app.post("/v1/me/link-wallet", requireAccount, async (c) => {
        const body = await c.req
          .json<{ pubkey?: string; nonce?: string; signature?: string }>()
          .catch((): { pubkey?: string; nonce?: string; signature?: string } => ({}));
        if (!body.pubkey || !body.nonce || !body.signature) {
          return c.json({ error: "faltan pubkey/nonce/signature", code: "bad_request" }, 400);
        }
        if (!(await verifyLogin(body.pubkey, body.nonce, body.signature))) {
          return c.json({ error: "firma inválida o nonce usado", code: "unauthorized" }, 401);
        }
        const existing = await accounts.byWallet(body.pubkey);
        if (existing && existing.id !== c.get("accountId")) {
          return c.json({ error: "wallet ya atada a otra cuenta", code: "wallet_taken" }, 409);
        }
        await accounts.linkWallet(c.get("accountId")!, body.pubkey);
        return c.json({ linked: true, walletPubkey: body.pubkey });
      });
    }

    app.get("/v1/me", requireAccount, async (c) => {
      const account = (await accounts.get(c.get("accountId")!))!;
      const balance = ledger ? await ledger.balance(account.id) : 0n;
      // Uso agregado: Σ telemetría por key propia (sin columna nueva en samples).
      let usage = { jobs: 0, ok: 0, okRate: 0 };
      if (keys && deps.telemetry) {
        const mine = await keys.listByOwner(account.id);
        const us = await Promise.all(mine.map((k) => deps.telemetry!.usage(k.id)));
        const jobs = us.reduce((a, u) => a + u.jobs, 0);
        const ok = us.reduce((a, u) => a + u.ok, 0);
        usage = { jobs, ok, okRate: jobs === 0 ? 0 : ok / jobs };
      }
      return c.json({
        accountId: account.id,
        walletPubkey: account.walletPubkey ?? null,
        balanceStroops: balance.toString(),
        balanceUSDC: Number(balance) / 1e7,
        depositMemo: depositMemoFor(account),
        depositAddress: deps.depositAddress ?? null,
        usage,
      });
    });

    app.get("/v1/me/billing", requireAccount, async (c) => {
      const accountId = c.get("accountId")!;
      const balance = ledger ? await ledger.balance(accountId) : 0n;
      const events = ledger ? await ledger.history(accountId, 100) : [];
      return c.json({
        balanceStroops: balance.toString(),
        balanceUSDC: Number(balance) / 1e7,
        events: events.map((e) => ({ ...e, amount: e.amount.toString(), amountUSDC: Number(e.amount) / 1e7 })),
      });
    });

    // Keys self-serve: owner = accountId — eso las conecta al billing (P3).
    if (keys) {
      app.post("/v1/me/keys", requireAccount, async (c) => {
        const { id, secret } = await keys.issue(c.get("accountId")!);
        return c.json({ id, secret }, 201);
      });
      app.get("/v1/me/keys", requireAccount, async (c) => c.json(await keys.listByOwner(c.get("accountId")!)));
      app.delete("/v1/me/keys/:id", requireAccount, async (c) => {
        const id = c.req.param("id") ?? "";
        // 404 para keys ajenas o inexistentes — no filtrar existencia.
        const mine = await keys.listByOwner(c.get("accountId")!);
        if (!mine.some((k) => k.id === id)) return c.json({ error: "key inexistente" }, 404);
        await keys.revoke(id);
        return c.json({ revoked: true });
      });
    }

    // Catálogo público de precios — el usuario ve el costo ANTES de gastar.
    if (deps.pricing) {
      const pricing = deps.pricing;
      app.get("/v1/pricing", (c) =>
        c.json({
          unit: "stroops_per_mtok",
          models: Object.fromEntries(
            pricing.list().map(({ model, price }) => [
              model,
              { prompt: price.prompt.toString(), completion: price.completion.toString(), image: price.image.toString() },
            ]),
          ),
        }),
      );
    }
  }

  // S48 (ADR-0007 P6): marketplace catalog — join de metadata declarada
  // (MODEL_CATALOG env) + fleet viva + pricing + medidas. Público siempre:
  // el catálogo existe aunque no haya accounts/billing. Lo no declarado sale
  // con declared:false; lo no medido sale null — jamás inventado.
  app.get("/v1/catalog", async (c) => {
    const meta = deps.catalog ?? {};
    const fleet = await Promise.resolve()
      .then(() => deps.forges())
      .catch(() => [] as ForgeView[]);
    const prices = deps.pricing
      ? Object.fromEntries(deps.pricing.list().map((p) => [p.model, p.price]))
      : {};
    const ids = new Set<string>([
      ...Object.keys(meta),
      ...fleet.map((f) => f.model),
      ...Object.keys(prices),
    ]);
    const models = [...ids].sort().map((id) => {
      const m = meta[id];
      const providers = fleet.filter((f) => f.model === id);
      const alive = providers.filter((f) => f.queueMs < 99_999);
      const ttfts = alive.map((f) => f.measuredTtftMs).filter((x): x is number => typeof x === "number");
      const toks = alive.map((f) => f.tokPerSec).filter((x): x is number => typeof x === "number");
      const p = prices[id];
      const features = m?.features ?? (providers.some((f) => f.capability === "image") ? ["image"] : []);
      return {
        id,
        name: m?.name ?? null,
        description: m?.description ?? null,
        context: m?.context ?? null,
        features,
        docs: m?.docs ?? null,
        declared: m !== undefined,
        pricing: {
          prompt: p ? p.prompt.toString() : null,
          completion: p ? p.completion.toString() : null,
          image: p ? p.image.toString() : null,
        },
        availability: {
          providers: providers.length,
          hot: alive.filter((f) => f.hot).length,
          available: alive.length > 0,
        },
        measured: {
          ttftMsP50: ttfts.length ? Math.min(...ttfts) : null,
          tokPerSec: toks.length ? Math.max(...toks) : null,
        },
      };
    });
    return c.json({ unit: "stroops_per_mtok", models });
  });

  // S7: kill switch del dashboard. Solo existe si el composition root da chaos.
  // S26: {forgeId} opcional — kill granular por forge (chaos drill real: morir
  // gemma-local no toca qwen3; morir image-local rompe solo la difusión).
  // S32: challenge de registro forge — abierto a propósito (el nonce no
  // autentica nada; la FIRMA del nonce con la keypair del forge sí).
  // Rate-limit del middleware ya cubre /v1/* si está configurado.
  if (deps.challenges) {
    const challenges = deps.challenges;
    app.post("/v1/forges/challenge", (c) => c.json(challenges.issue()));
  }

  if (deps.chaos) {
    const chaos = deps.chaos;
    app.post("/v1/admin/kill", requireOperator, async (c) => {
      const body = await c.req.json<{ dead?: boolean; forgeId?: string }>();
      const dead = body.dead === true;
      const forgeId = typeof body.forgeId === "string" && body.forgeId ? body.forgeId.slice(0, 80) : undefined;
      if (!chaos.setDead(forgeId, dead)) {
        return c.json({ error: "forge no controlable", code: "unknown_forge" }, 404);
      }
      return c.json({ dead, ...(forgeId ? { forgeId } : {}) });
    });
  }

  // S9a: historial de ejecuciones (in-memory, desde el boot) + estado del nodo.
  // S26: ?forgeId= filtra server-side — la consola de un forge ve SUS jobs.
  app.get("/v1/executions", async (c) => {
    const raw = c.req.query("limit") ?? "20";
    const limit = Math.min(50, Math.max(1, Number.parseInt(raw, 10) || 20));
    const forgeId = c.req.query("forgeId");
    let list = (await deps.telemetry?.recent(limit * (forgeId ? 4 : 1))) ?? [];
    if (forgeId) list = list.filter((s) => s.forgeId === forgeId).slice(0, limit);
    return c.json(list);
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

  // Agent host: capabilities que un browser no puede tener (MCP, web, skills,
  // persona del disco). El loop sigue client-side; esto solo descubre y ejecuta.
  if (deps.agent) {
    const agent = deps.agent;
    app.get("/v1/agent/manifest", async (c) => c.json(await agent.manifest()));
    app.post("/v1/agent/tools/call", async (c) => {
      const body = await c.req.json<{ name?: string; arguments?: Record<string, unknown> }>();
      if (!body.name || typeof body.name !== "string") {
        return c.json({ error: "falta name", code: "bad_request" }, 400);
      }
      const result = await agent.call(body.name.slice(0, 120), body.arguments ?? {});
      return c.json({ result });
    });

    // Upload de documentos: el browser manda el archivo, acá se extrae texto
    // (pdf/docx/txt/código). El binario jamás entra al contexto del modelo.
    app.post("/v1/agent/files", async (c) => {
      const form = await c.req.parseBody().catch(() => null);
      const f = form?.file;
      if (!(f instanceof File)) return c.json({ error: "falta campo file (multipart)", code: "bad_request" }, 400);
      if (f.size > 2_000_000) return c.json({ error: "archivo >2MB", code: "file_too_large" }, 413);
      try {
        const text = await extractDocText(f.name || "doc", Buffer.from(await f.arrayBuffer()));
        return c.json({ name: f.name, chars: text.length, text });
      } catch (e) {
        return c.json({ error: e instanceof Error ? e.message : "no se pudo extraer", code: "extract_failed" }, 422);
      }
    });
  }

  // Artefactos generados (imágenes hoy, video cuando haya forge): in-memory,
  // expiran con el proceso — igual que el resto de la telemetría dev.
  if (deps.media) {
    const media = deps.media;
    app.get("/v1/media/:id", (c) => {
      const m = media.get(c.req.param("id"));
      if (!m) return c.json({ error: "media inexistente o expirada", code: "not_found" }, 404);
      return new Response(new Uint8Array(m.buf), { headers: { "content-type": m.mime, "cache-control": "no-store" } });
    });
  }

  // OpenAI-compatible image gen, ruteada por el MISMO scheduler que el chat:
  // el forge COLD paga load_time medido — el ETR deja de ser promesa y pasa
  // a ser medición. Telemetría: para jobs sin tokens, ttftMs = duración total.
  if (deps.imageExecs) {
    const imageExecs = deps.imageExecs;
    app.post("/v1/images/generations", async (c) => {
      const body = await c.req.json<{ model?: string; prompt?: string; size?: string; n?: number }>();
      if (!body.model || !body.prompt?.trim()) {
        return c.json({ error: "faltan model/prompt", code: "bad_request" }, 400);
      }
      if (body.prompt.length > 4000) return c.json({ error: "prompt demasiado largo", code: "prompt_too_large" }, 413);
      const candidates = (await deps.forges()).filter(
        (f) => f.model === body.model && f.capability === "image" && f.attested !== false && imageExecs[f.forgeId] !== undefined,
      );
      if (candidates.length === 0) return c.json({ error: "modelo sin forges de imagen", code: "unknown_model" }, 404);
      // S29: una imagen saturada no encola — 429 honesto (difusión ocupa el
      // proceso entero; dos jobs concurrentes se pisan la VRAM).
      const open = candidates.filter((f) => f.saturated !== true && f.queueMs < DEAD_QUEUE_MS);
      if (open.length === 0) return c.json({ error: "forges de imagen ocupados, reintentar", code: "busy" }, 429);
      // S47: billing prepago de imagen — flat por generación (sin tokens).
      const billImg =
        deps.ledger && deps.pricing && c.get("keyOwner")?.startsWith("acct_") ? c.get("keyOwner")! : null;
      if (billImg) {
        const bal = await deps.ledger!.balance(billImg);
        const need = deps.pricing!.minCost(body.model, "image");
        if (bal < need) {
          return c.json(
            { error: "créditos insuficientes", code: "insufficient_credits", balanceStroops: bal.toString(), neededStroops: need.toString() },
            402,
          );
        }
      }
      const jobId = `img-${crypto.randomUUID()}`;
      const d = scheduler.select({ id: jobId, model: body.model }, open);
      const ex = imageExecs[d.forgeId]; // candidates ya exige exec registrado
      const t0 = Date.now();
      try {
        const r = await ex.generateImage({ jobId, model: body.model, prompt: body.prompt.trim(), size: body.size });
        // S40: resultado de forge REMOTO → debe decodificar a imagen real
        // (PNG/JPEG/WebP con dims). Basura firmable no existe, pero basura
        // a secas sí — no se sirve al cliente ni cuenta como éxito.
        if (deps.forgePubkeyOf?.(r.forgeId) !== undefined && imageDims(r.b64) === null) {
          deps.breaker?.fail(r.forgeId);
          deps.telemetry?.record({ forgeId: r.forgeId, model: body.model, ttftMs: Date.now() - t0, ok: false, ts: Date.now(), keyId: c.get("keyId") }).catch(() => {});
          return c.json({ error: "forge remoto devolvió imagen inválida", code: "forge_failed" }, 502);
        }
        deps.breaker?.ok(r.forgeId); // S27: éxito resetea sus fallos consecutivos
        deps.telemetry?.record({ forgeId: r.forgeId, model: body.model, ttftMs: r.ms, ok: true, ts: Date.now(), keyId: c.get("keyId") }).catch(() => {});
        // S47: debit flat post-gen — imagen servida = trabajo hecho.
        if (billImg) {
          const cost = deps.pricing!.costOfImage(body.model);
          if (cost > 0n) void deps.ledger!.debit(billImg, cost, `job:${jobId}`).catch(() => {});
        }
        let mediaUrl: string | undefined;
        if (deps.media) {
          const id = crypto.randomUUID();
          if (deps.media.size > 50) deps.media.delete(deps.media.keys().next().value!);
          deps.media.set(id, { buf: Buffer.from(r.b64, "base64"), mime: "image/png" });
          mediaUrl = `/v1/media/${id}`;
        }
        return c.json({
          created: Math.floor(t0 / 1000),
          data: [{ b64_json: r.b64, ...(mediaUrl ? { url: mediaUrl } : {}) }],
          weaver: { forge: r.forgeId, ms: r.ms, reason: d.reason },
        });
      } catch (e) {
        deps.breaker?.fail(d.forgeId); // S27: el breaker ve el fallo de imagen también
        deps.telemetry?.record({ forgeId: d.forgeId, model: body.model, ttftMs: Date.now() - t0, ok: false, ts: Date.now(), keyId: c.get("keyId") }).catch(() => {});
        return c.json({ error: e instanceof Error ? e.message : "imagegen falló", code: "forge_failed" }, 502);
      }
    });
  }

  // S2: SSE mínimo OpenAI-compatible. El exec streamea, el gateway solo enmarca.
  app.post("/v1/chat/completions", async (c) => {
    if (!deps.exec) return c.json({ error: "sin forge de ejecución" }, 503);
    const body = await c.req.json<{
      model: string;
      messages: { role: string; content: string; tool_calls?: unknown; name?: string }[];
      max_tokens?: number;
      temperature?: number;
      top_p?: number;
      think?: boolean;
      num_ctx?: number;
      tools?: unknown[];
    }>();
    const rawMessages = Array.isArray(body.messages) ? body.messages : [];
    // Mensajes verbatim al engine (roles/system/tool_calls intactos): solo se
    // filtran entradas malformadas, no se aplasta el contexto.
    const messages = rawMessages.filter(
      (m) => m && typeof m.role === "string" && typeof m.content === "string",
    );
    const prompt = messages.map((m) => m.content).join("\n");
    // S11: caps anti-DoS (un request gigante ahoga Ollama). 413 con código, jamás 500 ni OOM.
    // Dimensionados para el agente: system + persona + historial + tool results
    // caben en un num_ctx de 16k (≈60k chars) sin dejar el request abierto a OOM.
    if (messages.length > 60 || prompt.length > 60_000) {
      return c.json({ error: "prompt demasiado grande", code: "prompt_too_large" }, 413);
    }
    // Tools verbatim al engine; cap acotado para no inflar el prompt de sistema.
    const tools = Array.isArray(body.tools) && body.tools.length <= 48 ? body.tools : undefined;
    // Whitelist OpenAI→engine: lo que el cliente no mande, no se inventa.
    const options = {
      ...(body.max_tokens !== undefined ? { maxTokens: body.max_tokens } : {}),
      ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
      ...(body.top_p !== undefined ? { topP: body.top_p } : {}),
      ...(body.think !== undefined ? { think: body.think } : {}),
      ...(body.num_ctx !== undefined ? { numCtx: body.num_ctx } : {}),
    };
    // S19: el modelo pedido debe existir en la fleet COMO TEXTO — si no, 404
    // antes de abrir stream ni tocar un forge (nada de servir otro modelo en
    // silencio, ni rutear un modelo de imagen al puerto de chat).
    const fleet = await deps.forges();
    if (!fleet.some((f) => f.model === body.model && (f.capability ?? "text") === "text")) {
      return c.json({ error: "modelo sin forges de texto", code: "unknown_model" }, 404);
    }
    // S29: admission control — si todos los forges VIVOS del modelo están
    // saturados, 429 honesto ahora en vez de un stream que cuelga en cola.
    // Muertos/breaker no cuentan: sin vivos, el failover decide (o 502 real).
    const alive = fleet.filter(
      (f) => f.model === body.model && (f.capability ?? "text") === "text" && f.attested !== false && f.queueMs < DEAD_QUEUE_MS,
    );
    if (alive.length > 0 && alive.every((f) => f.saturated === true)) {
      return c.json({ error: "forges saturados, reintentar", code: "busy" }, 429);
    }
    // S47 (ADR-0007): billing prepago — keys con owner acct_* consumen crédito.
    // Pre-serve: balance >= costo mínimo estimado o 402 (fail closed ANTES de
    // tocar el forge). Post-serve: debit del costo MEDIDO (usage del engine).
    const billTo =
      deps.ledger && deps.pricing && c.get("keyOwner")?.startsWith("acct_") ? c.get("keyOwner")! : null;
    if (billTo) {
      const bal = await deps.ledger!.balance(billTo);
      const need = deps.pricing!.minCost(body.model, "text");
      if (bal < need) {
        return c.json(
          { error: "créditos insuficientes", code: "insufficient_credits", balanceStroops: bal.toString(), neededStroops: need.toString() },
          402,
        );
      }
    }
    const exec = deps.exec;
    const id = `chatcmpl-${crypto.randomUUID()}`;
    // S9a/S19: telemetría de la ejecución real — onForge reporta por request
    // quién sirvió (sin espiar internals ni estado compartido entre requests).
    const t0 = Date.now();
    let firstAt = -1;
    let servedForgeId: string | null = null;
    // S28: stats del frame done → el sample lleva genTokens/decodeMs medidos.
    let lastStats: ExecStats | null = null;
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
        ...(lastStats?.genTokens !== undefined
          ? { genTokens: lastStats.genTokens, decodeMs: lastStats.decodeMs }
          : {}),
      };
      // S47: debit prepago — post-serve sobre usage MEDIDO del engine, ref
      // estable por job (job:chatcmpl-…) → retry/reconnect jamás debita dos
      // veces. Sin stats reportados: minCost (el trabajo se hizo igual).
      // Fire-and-forget como el settle — jamás frena el cierre del stream.
      if (ok && billTo) {
        const cost = lastStats
          ? deps.pricing!.costOf(body.model, {
              promptTokens: lastStats.promptTokens ?? 0,
              completionTokens: lastStats.genTokens ?? 0,
            })
          : deps.pricing!.minCost(body.model);
        if (cost > 0n) void deps.ledger!.debit(billTo, cost, `job:${id}`).catch(() => {});
      }
      // S17b: lo fallido no se paga (solo se registra). Lo OK liquida en background:
      // fire-and-forget a propósito — settle lento o caído jamás frena ni voltea requests.
      const payerHeader = c.get("paymentHeader");
      const payerReqs = c.get("paymentReqs");
      const servedProof = proof;
      // S37: proof de forge remoto → verificación local SIEMPRE (haya o no
      // settlement). Firma inválida = mintió sobre identidad u output:
      // breaker + settle:failed. Embedded (sin pubkey en registry) salta
      // esto: firma local, la verifica el contrato en release.
      const worker = servedProof ? deps.forgePubkeyOf?.(servedProof.forgeId) : undefined;
      if (ok && servedProof && worker && deps.verifyProof &&
          !deps.verifyProof(worker, servedProof.resultHash, servedProof.signature)) {
        deps.breaker?.fail(servedProof.forgeId);
        deps.telemetry?.record({ ...base, settle: { status: "failed" } }).catch(() => {});
        return;
      }
      // S38: audit probabilístico — re-attestation del forge que sirvió
      // contra una referencia del mismo modelo. Solo remotos (worker !==
      // undefined); fire-and-forget, nunca bloquea el settle.
      if (ok && servedProof && worker) deps.audit?.(servedProof.forgeId, body.model);
      if (!ok || (!deps.settlement && !payerHeader)) {
        deps.telemetry?.record(base).catch(() => {});
        return;
      }
      const settlement = deps.settlement;
      const idemKey = c.req.header("idempotency-key");
      const paywall = deps.paywall;
      void (async () => {
        // S23: pata cliente — x402 settle ejecuta el pago YA verificado.
        let payerTx: string | undefined;
        let payerOk = true;
        if (payerHeader && payerReqs && paywall) {
          const s = await paywall.verifier.settle(payerHeader, payerReqs);
          payerOk = s.success;
          payerTx = s.txHash;
          // P9: el cliente se sirvió y su pago falló — bleeding del operador.
          // Visible en logs, no silencioso.
          if (!payerOk) console.warn(`x402 settle falló post-serve (job ${base.forgeId}) — cliente sirvió gratis`);
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
            ? await settleOnce(settlement, idemKey, servedProof.resultHash, servedProof.signature, worker, lastStats ?? undefined)
            : await settlement.settleJob(servedProof.resultHash, servedProof.signature, worker, lastStats ?? undefined);
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
        const chunk = (delta: Record<string, unknown>, finish: string | null = null, extra?: Record<string, unknown>) =>
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta, finish_reason: finish }],
            ...extra,
          })}\n\n`;
        try {
          // Convención OpenAI: el primer frame (role) sale antes de tocar el forge
          // → first-byte ≈ RTT, no TTFT del modelo. TTFT honesto se mide abajo.
          send(chunk({ role: "assistant" }));
          for await (const tok of exec.execute({
            jobId: id,
            model: body.model,
            prompt,
            messages,
            options,
            tools,
            onForge: (fid) => {
              servedForgeId = fid;
              deps.breaker?.ok(fid); // sirvió: resetea sus fallos consecutivos
            },
            onFail: (fid) => {
              deps.breaker?.fail(fid); // intento fallido (pre-token o mid-stream)
            },
            onProof: (p) => {
              proof = p;
            },
          })) {
            if (firstAt < 0) firstAt = Date.now();
            if (tok.done) {
              // Frame final OpenAI: finish_reason + usage si el engine reportó.
              const stats = tok.stats;
              lastStats = stats ?? null; // S28: al sample de telemetría
              const usage =
                stats?.promptTokens !== undefined || stats?.genTokens !== undefined
                  ? {
                      usage: {
                        prompt_tokens: stats.promptTokens ?? 0,
                        completion_tokens: stats.genTokens ?? 0,
                        total_tokens: (stats.promptTokens ?? 0) + (stats.genTokens ?? 0),
                      },
                    }
                  : undefined;
              // Tool calls: shape OpenAI (arguments stringificado) antes del
              // finish — el cliente ejecuta y re-envía con role:"tool".
              if (tok.toolCalls?.length) {
                send(
                  chunk({
                    tool_calls: tok.toolCalls.map((tc, i) => ({
                      index: i,
                      id: `call_${id.slice(-8)}_${i}`,
                      type: "function",
                      function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
                    })),
                  }),
                );
                send(chunk({}, "tool_calls", usage));
              } else {
                send(chunk({}, "stop", usage));
              }
              break;
            }
            // Razonamiento → delta.reasoning (convención DeepSeek/Ollama); los
            // clientes que no lo leen no lo pierden: no es parte de la respuesta.
            send(chunk(tok.kind === "think" ? { reasoning: tok.token } : { content: tok.token }));
          }
          send("data: [DONE]\n\n");
          telRecord(true);
        } catch (e) {
          // S3: muerte mid-stream → evento error explícito, jamás [DONE] trucho.
          // El mensaje real viaja: "forge-failed" pelado esconde OOMs, evicciones
          // y timeouts que el operador necesita ver (telemetría ya lo registra).
          const msg = e instanceof Error ? e.message : String(e);
          send(`data: ${JSON.stringify({ error: "forge-failed", detail: msg.slice(0, 300) })}\n\n`);
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
      headers: {
        "content-type": "text/event-stream",
        // no-transform + x-accel-buffering:no: ningún proxy/buffer intermedio
        // puede retener chunks — cada token sale en cuanto llega (TTFT real).
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  });

  return app;
}
