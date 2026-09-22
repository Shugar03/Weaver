// Composition root: forges reales + standby simulado + kill switch.
// - ollama-local: Forge real (Ollama en la Air), HOT mientras vive.
// - forge-sim-01: capacidad SIMULADA (badge SIM en UI) para demo de routing/failover.
// - KILL apaga el primario: el scheduler lo ve COLD caro y el failover salta al sim.
// Env (todo opcional, defaults = dev local idéntico a siempre):
//   PORT, HOST (default 127.0.0.1 — público exige 0.0.0.0 explícito),
//   CORS_ORIGIN (coma-separado; ausente = abierto),
//   OPERATOR_KEY (fija el admin entre reinicios; ausente = efímera impresa),
//   PAYWALL_PAY_TO (presente = paywall x402 ON; ausente = off),
//   RATE_LIMIT_RPM (default 120; 0 = off),
//   SETTLEMENT_SECRET (presente = escrow operador→worker ON),
//   WORKER_SECRET (clave ed25519 del forge — firma el proof L0 de cada output;
//   requerida para que el contrato v3 verifique el release).
// Uso: `node apps/gateway/src/serve.ts` (dejar corriendo en una terminal).
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "./index.ts";
import { createAgentHost } from "./agent.ts";
import { Auditor } from "./audit.ts";
import { FakeForgeExec, FluxKleinForge, OllamaMLXAdapter, ProvenForgeExec, RoutedExec, SwitchableExec, TrackedExec, TrackedImageExec } from "@weaver/forge-exec";
import type { ExecRequest, ForgeExec, ImageExec } from "@weaver/forge-exec";
import { InMemoryApiKeys, PostgresApiKeys } from "@weaver/api-keys";
import { EscrowSettlement, FacilitatorVerifier, InMemorySettleJournal, PostgresSettleJournal, registerForge, RpcSubmitter, stellarPubkey, stellarSigner, stellarVerify, sweepPendingSettles } from "@weaver/settlement";
import { InMemoryTelemetry, PostgresTelemetry } from "@weaver/telemetry";
import { dbFromUrl } from "@weaver/db";
import { applyBreaker, CircuitBreaker, etrMs, queueMsFor, type ForgeView } from "@weaver/scheduler";
import { ForgeRegistry, InMemoryForgeStore, NonceStore, PostgresForgeStore } from "@weaver/forge-net";
import { attachForgeWS } from "./forgews.ts";
import type { Server as HttpServer } from "node:http";

// S27: cap de jobs concurrentes por forge — un runner Ollama serializa, más
// in-flight que esto solo infla queueMs sin throughput real.
const MAX_INFLIGHT_TEXT = 4;
const MAX_INFLIGHT_IMAGE = 1;

// Switchable (chaos kill por forge) → Proven (firma L0) → Tracked (in-flight).
// Las refs "Sw" quedan para el chaos; el registry lleva la capa externa.
const primarySw = new SwitchableExec(new OllamaMLXAdapter({ model: "qwen3:4b" }));
// S26: todos los forges son switchable — kill granular por forgeId para chaos
// drills reales (matar gemma no toca qwen; matar image rompe solo difusión).
const standbySw = new SwitchableExec(new FakeForgeExec({ forgeId: "forge-sim-01", model: "qwen3:4b" }));
// Segundo modelo real en el MISMO Ollama (un engine, N forges lógicos).
// e2b ≈7.2GB: residente junto a qwen3 (~10.5GB) en una 16GB Air sin swap.
// gemma con keep_alive acotado: en 16GB, dos LLM residentes + el forge de imagen
// (~5GB peak) hacen que Ollama evicte mid-request → streams muertos. 5min idle
// → se descarga solo; el probe /api/ps lo muestra COLD honesto entre usos.
const gemmaSw = new SwitchableExec(new OllamaMLXAdapter({ forgeId: "gemma-local", model: "gemma4:e2b", keepAlive: 300 }));
// Image forge: mismo Ollama, runner MLX de difusión. COLD declarado — Ollama
// no mantiene el modelo residente entre gens, así que cada job paga load real
// y la telemetría lo mide (la demo del cold-start es la feature, no un bug).
const imageForgeInner = new FluxKleinForge({ forgeId: "image-local", model: "flux2-klein-4b" });
const imageForge = new TrackedImageExec(imageForgeInner);

// S27: circuit breaker — ≥3 fallos de exec en 60s → forge fuera 30s.
// Sin esto un forge roto con probe vivo se intenta primero en cada request.
const breaker = new CircuitBreaker();

const OLLAMA_VIEW: ForgeView = {
  forgeId: "ollama-local",
  model: "qwen3:4b",
  hot: true,
  rttMs: 5,
  queueMs: 0,
  loadTimeMs: 0,
  price: 0,
  reliability: 1,
};
const GEMMA_VIEW: ForgeView = {
  forgeId: "gemma-local",
  model: "gemma4:e2b",
  hot: true, // el probe /api/ps corrige a real (COLD cuando keep_alive lo descargó)
  rttMs: 5,
  queueMs: 0,
  loadTimeMs: 2500, // honesto: ~2-3s de carga cuando está COLD
  price: 0,
  reliability: 1,
};
const SIM_VIEW: ForgeView = {
  forgeId: "forge-sim-01",
  model: "qwen3:4b",
  hot: false,
  rttMs: 140,
  queueMs: 2,
  loadTimeMs: 4000,
  price: 0.0004,
  reliability: 0.99,
  sim: true,
};
const IMAGE_VIEW: ForgeView = {
  forgeId: "image-local",
  model: "flux2-klein-4b",
  capability: "image", // difusión: no es elegible para chat ni lista en /v1/models
  hot: false, // difusión sin keep_alive: COLD entre jobs, load_time real en cada gen
  rttMs: 5,
  queueMs: 0,
  loadTimeMs: 20_000,
  price: 0,
  reliability: 1,
};

// S9a: historial en memoria = desde el boot (se declara en la UI /forge).
// S16a: con DATABASE_URL, Postgres; sin ella, in-memory (dev).
const telemetry = process.env.DATABASE_URL
  ? new PostgresTelemetry(dbFromUrl(process.env.DATABASE_URL))
  : new InMemoryTelemetry();

// S30–S32 (ADR-0005): registry de forges REMOTOS — el ForgeView nace del
// heartbeat (TTL 15s), la identidad persiste en store. nonces = challenges
// del handshake; el socket vive en attachForgeWS (abajo, sobre el server http).
const forgeStore = process.env.DATABASE_URL
  ? new PostgresForgeStore(dbFromUrl(process.env.DATABASE_URL))
  : new InMemoryForgeStore();
const registry = new ForgeRegistry(forgeStore);
const nonces = new NonceStore();
// S44 (I3): journal de escrows — toda plata fondeada queda referenciada;
// el sweep de boot re-liquida o reembolsa lo que quedó pending.
const settleJournal = process.env.DATABASE_URL
  ? new PostgresSettleJournal(dbFromUrl(process.env.DATABASE_URL))
  : new InMemorySettleJournal();
// Los mapas los crea attachForgeWS al levantar el server; antes de eso el
// registry simplemente no tiene remotos (probeAll/forges los ignoran).
let forgeWS: ReturnType<typeof attachForgeWS> | null = null;

// S23: los execs firman el sha256 de su propio output (Proof L0) cuando hay
// WORKER_SECRET. El contrato verifica la firma en release — sin proof, no paga.
// Sin secret: execs sin firmar → settle queda "failed" honesto (no se fabrica).
const sign = process.env.WORKER_SECRET ? stellarSigner(process.env.WORKER_SECRET) : undefined;

// S19: registry forgeId→exec. El router ordena la fleet por ETR en cada request
// y el failover corre sobre ESE orden — la decisión del scheduler ES el dispatch.
// S27: la capa externa es TrackedExec — inFlight real alimenta queueMs.
const wrap = (e: ForgeExec): ForgeExec => new TrackedExec(sign ? new ProvenForgeExec(e, sign) : e);
const execs: Record<string, ForgeExec> = {
  "ollama-local": wrap(primarySw),
  "forge-sim-01": wrap(standbySw),
  "gemma-local": wrap(gemmaSw),
};

// Warm-up: un request de 1 token con keep_alive=-1 deja el modelo residente en
// el engine → load_time = 0 siempre. Sin esto el primer request post-boot (o
// post-evicción a los 5min idle de Ollama) paga la carga completa (~1.7s).
const warmup = async (e: ForgeExec) => {
  try {
    for await (const _ of e.execute({
      jobId: `warmup-${Date.now()}`,
      model: e.model,
      prompt: "hi",
      // num_ctx igual al del agente (NUM_CTX=16384 en el cliente): si el runner
      // queda residente a 4k, el primer request real paga un resize (reload
      // completo del modelo, ~segundos) que contamina el TTFT medido.
      options: { maxTokens: 1, think: false, numCtx: 16384 },
    })) {
      /* drain */
    }
  } catch {
    /* forge caído o modelo sin pull: probeAll reintenta en cada ciclo */
  }
};

// S24: liveness real — probe() cada 5s marca forges inalcanzables COLD antes de
// que fallen requests. El failover de dispatch sigue como red de seguridad.
// Además: refresca el cache de p50 (hot path sin awaits de telemetría — con
// Postgres eran 2 RTTs a la DB por request antes de abrir el socket al forge)
// y re-calienta un forge que vuelve de una caída (Ollama reiniciado = modelo
// descargado: sin re-warm la recuperación pagaría load_time en el primer job).
const live = new Map<string, boolean>();
// resident = modelo cargado en el engine (probe=alcanzable, resident=cargado).
// Con keep_alive acotado o presión de RAM, Ollama descarga entre jobs: el forge
// sigue ruteable pero COLD — el scheduler cobra loadTimeMs en vez de declararlo
// muerto. qwen3 también puede ser evictado bajo presión: mismo chequeo honesto.
const resident = new Map<string, boolean>();
const p50cache = new Map<string, number>();
// S28: tok/s por forge (medido, cache 5s junto al p50).
const tokCache = new Map<string, number>();
// S36: reliability medida por forge (ok/total en la ventana de samples).
const relCache = new Map<string, number>();
const probeAll = async () => {
  for (const [id, e] of Object.entries(execs)) {
    let up = false;
    try {
      up = (await e.probe?.()) ?? true;
    } catch {
      up = false;
    }
    const was = live.get(id);
    live.set(id, up);
    if (up && was === false && (id === "ollama-local" || id === "gemma-local")) void warmup(execs[id]);
    try {
      resident.set(id, up ? ((await e.resident?.()) ?? true) : false);
    } catch {
      resident.set(id, false);
    }
  }
  // El image forge se probee aparte (puerto distinto, no está en `execs`).
  try {
    live.set("image-local", (await imageForge.probe?.()) ?? true);
  } catch {
    live.set("image-local", false);
  }
  // S30: p50/tok por instance remota también — la telemetría es agnóstica al
  // transporte (el sample graba forgeId = instanceId, mismo que el view).
  const all = [...[OLLAMA_VIEW, SIM_VIEW, GEMMA_VIEW, IMAGE_VIEW], ...registry.views()];
  for (const f of all) {
    const v = await telemetry.p50(f.model, f.forgeId).catch(() => 0);
    if (v > 0) p50cache.set(f.forgeId, v);
    else p50cache.delete(f.forgeId);
  }
  // S28: tok/s medido por forge — Σ genTokens / Σ decodeMs de samples con stats
  // (solo ok; un fallo no tiene decode). Misma ventana de frescura que el p50.
  const rec = await telemetry.recent(200).catch(() => []);
  for (const f of all) {
    const xs = rec.filter((s) => s.forgeId === f.forgeId && s.ok && s.genTokens && s.decodeMs);
    if (xs.length === 0) {
      tokCache.delete(f.forgeId);
    } else {
      const tok = xs.reduce((a, s) => a + s.genTokens!, 0);
      const ms = xs.reduce((a, s) => a + s.decodeMs!, 0);
      if (ms > 0) tokCache.set(f.forgeId, (tok / ms) * 1000);
    }
    // S36: reliability = fracción ok sobre la ventana — medida, no declarada.
    // Sin samples no hay evidencia de fallo → queda la declarada (honesto).
    const all = rec.filter((s) => s.forgeId === f.forgeId);
    if (all.length > 0) relCache.set(f.forgeId, all.filter((s) => s.ok).length / all.length);
  }
};
void probeAll().then(() => Promise.all([warmup(execs["ollama-local"]), warmup(execs["gemma-local"])]));
setInterval(() => void probeAll(), 5_000).unref();

// S20: el p50 medido por forge alimenta el ETR — "measured, not marketing".
// El medido viene del cache que probeAll refresca cada 5s (stale acotado:
// un p50 no cambia entre requests). Forge muerto: hot=false y el medido
// stale no aplica (scheduler lo ignora). Síncrono en la práctica: el dispatch
// ya no espera telemetría antes de abrir el stream.
async function forges(): Promise<ForgeView[]> {
  const ollamaUp = !primarySw.isDead() && live.get("ollama-local") !== false;
  const base =
    !ollamaUp
      ? [{ ...OLLAMA_VIEW, hot: false, queueMs: 99999 }, SIM_VIEW]
      : [{ ...OLLAMA_VIEW, hot: resident.get("ollama-local") !== false }, SIM_VIEW];
  // gemma-local: mismo Ollama que el primario — si el engine cae, ambos muertos.
  // Engine vivo + modelo descargado = COLD ruteable (ETR cobra load_time real);
  // engine caído = muerto. Sin standby: falla honesto, no hay fake.
  if (!ollamaUp) base.push({ ...GEMMA_VIEW, hot: false, queueMs: 99999 });
  else base.push({ ...GEMMA_VIEW, hot: resident.get("gemma-local") !== false });
  if (live.get("image-local") === false) base.push({ ...IMAGE_VIEW, hot: false, queueMs: 99999 });
  else base.push(IMAGE_VIEW);
  // S30: forges remotos entran por heartbeat — mismo deco de carga medida.
  base.push(...registry.views());
  // S27: carga medida — queueMs = inFlight × expectedMs (expected = p50 medido;
  // sin historia, 500ms HOT o el load_time declarado COLD). inFlight/saturated
  // van en el view: la UI muestra cola real y el admission control lo lee.
  const deco = base.map((f) => {
    const dead = f.queueMs >= 99_999;
    const tracked = (f.forgeId === "image-local"
      ? imageForge
      : ((execs[f.forgeId] ?? forgeWS?.remoteExecs.get(f.forgeId) ?? forgeWS?.remoteImageExecs.get(f.forgeId)) as unknown as
        | { inFlight: number }
        | undefined));
    // Remote sin exec todavía: cae al inFlight del heartbeat (self-report).
    const n = tracked?.inFlight ?? f.inFlight ?? 0;
    const cap = (f.capability ?? "text") === "image" ? MAX_INFLIGHT_IMAGE : MAX_INFLIGHT_TEXT;
    const expected = p50cache.get(f.forgeId) ?? (f.hot ? 500 : f.loadTimeMs);
    return {
      ...f,
      measuredTtftMs: p50cache.get(f.forgeId),
      tokPerSec: tokCache.get(f.forgeId) ?? f.tokPerSec, // heartbeat si no hay historia local
      reliability: relCache.get(f.forgeId) ?? f.reliability, // S36: medida cuando hay samples
      inFlight: n,
      // Remote: el cap lo conoce el forge (su config) → self-report. Embedded:
      // cap local fijo del composition root.
      saturated: f.remote ? f.saturated === true : !dead && n >= cap,
      queueMs: dead ? f.queueMs : queueMsFor(n, expected),
    };
  });
  return applyBreaker(deco, breaker);
}

const apiKeys = process.env.DATABASE_URL
  ? new PostgresApiKeys(dbFromUrl(process.env.DATABASE_URL))
  : new InMemoryApiKeys();

if (process.env.SETTLEMENT_SECRET && !sign) {
  console.warn("SETTLEMENT_SECRET sin WORKER_SECRET: los settle quedarán failed (sin proof L0)");
}

const corsOrigins = (process.env.CORS_ORIGIN ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const payTo = process.env.PAYWALL_PAY_TO;
const rpm = Number(process.env.RATE_LIMIT_RPM ?? 120);

// S31: execs "vivos" — embedded + remotos detrás del mismo mapa para
// RoutedExec. El proxy lee perezoso: un forge que aparece en el heartbeat
// es ruteable en el siguiente select() sin reiniciar nada.
const liveExecs = new Proxy(execs, {
  get: (t, k) => t[k as string] ?? forgeWS?.remoteExecs.get(k as string),
});
const exec = new RoutedExec<ForgeView>({
  // Solo forges de texto: si el request pide un modelo de imagen, sin candidatos
  // → error honesto "sin execs", no un dispatch al puerto equivocado.
  // Remoto sin attestation no entra a routing: tiene que probar que ejecuta
  // y firma con su key registrada antes de ver un job real (ADR-0005).
  forges: async () =>
    (await forges()).filter((f) => (f.capability ?? "text") === "text" && f.attested !== false),
  execs: liveExecs,
  order: (req: ExecRequest, views: ForgeView[]) => {
    // S28: max_tokens del request = tamaño del job → el ETR pondera el decode
    // esperado (tok/s medido), no solo el primer token.
    const job = { id: req.jobId, model: req.model, estOutTokens: req.options?.maxTokens };
    return [...views].sort((a, b) => etrMs(a, job) - etrMs(b, job));
  },
});

// S38 — audit replay (ADR-0005): la lógica vive en audit.ts (testeable);
// acá solo el umbral probabilístico y el wiring al fleet vivo.
const AUDIT_RATE = Number(process.env.AUDIT_RATE ?? "0.05");
const auditor = new Auditor({
  views: forges,
  execOf: (forgeId) => liveExecs[forgeId] as ForgeExec | undefined,
  breaker,
  // S46: strikes por pubkey, persistidos en el forge store — un restart del
  // gateway no perdona a un forge que mintió.
  strikes: {
    add: (pk) => forgeStore.addStrike(pk),
    reset: (pk) => forgeStore.resetStrikes(pk),
  },
});

const imageExecs: Record<string, ImageExec> = { "image-local": imageForge };
// Misma seam que liveExecs para imágenes: remoteImageExecs entra por WS.
const liveImageExecs = new Proxy(imageExecs, {
  get: (t, k) => t[k as string] ?? forgeWS?.remoteImageExecs.get(k as string),
});
// Artefactos de media: in-memory, cap 50, expiran con el proceso.
const media = new Map<string, { buf: Buffer; mime: string }>();

const app = createApp({
  forges,
  exec,
  // cwd = raíz del repo, derivada del módulo — no del cwd de launch (si el
  // gateway arranca desde apps/gateway, skills/ y weaver.mcp.json no existirían).
  agent: createAgentHost({
    cwd: fileURLToPath(new URL("../../..", import.meta.url)),
    gatewayBase: `http://127.0.0.1:${Number(process.env.PORT ?? 3001)}`,
  }),
  imageExecs: liveImageExecs,
  media,
  // S26: kill granular — cada forge es controlable; sin forgeId = primary
  // (compat con el kill switch global del RunPanel).
  chaos: {
    setDead: (forgeId: string | undefined, dead: boolean): boolean => {
      const target =
        forgeId === undefined || forgeId === "ollama-local" ? primarySw
        : forgeId === "forge-sim-01" ? standbySw
        : forgeId === "gemma-local" ? gemmaSw
        : forgeId === "image-local" ? imageForgeInner
        : null;
      if (!target) return false;
      target.setDead(dead);
      if (!dead) breaker.ok(forgeId ?? "ollama-local"); // revive = reset del breaker
      return true;
    },
  },
  breaker,
  challenges: nonces,
  // S34: payout per-forge — la pubkey del registry ES la cuenta que cobra.
  forgePubkeyOf: (forgeId) => registry.pubkeyOf(forgeId),
    // S37: toda firma de forge remoto se verifica antes del release.
  verifyProof: stellarVerify,
  // S38: audit replay — con probabilidad AUDIT_RATE re-ejecutamos el prompt
  // canónico (temp 0) en el forge que sirvió Y en una referencia del mismo
  // modelo; hash distinto = strike. 2 strikes seguidos → breaker (miente el
  // modelo). Solo forges remotos entran (embedded = referencia confiable).
  audit: (forgeId, model) => {
    if (Math.random() >= AUDIT_RATE || registry.pubkeyOf(forgeId) === undefined) return;
    void auditor.run(forgeId, model);
  },
  telemetry,
  node: { version: "0.1.0", startedAt: Date.now() },
  apiKeys,
  ...(corsOrigins.length ? { corsOrigins } : {}),
  ...(rpm > 0 ? { rateLimit: { rpm } } : {}),
  // S15a: paywall opt-in por env. Sin PAYWALL_PAY_TO, abierto (dev/demo).
  ...(payTo ? { paywall: { verifier: new FacilitatorVerifier(), payTo } } : {}),
  // S17b/S42: liquidación opt-in. El operador DERIVA de SETTLEMENT_SECRET (su
  // pubkey — un G... hardcodeado desalineado dejaría toda tx sin auth).
  // SETTLEMENT_CONTRACT es obligatorio: sin default — un contractId stale
  // contra un contrato de ABI vieja rompería cada settle silenciosamente.
  ...(process.env.SETTLEMENT_SECRET && process.env.SETTLEMENT_CONTRACT
    ? {
        settlement: new EscrowSettlement(
          new RpcSubmitter(process.env.SOROBAN_RPC ?? "https://soroban-testnet.stellar.org", process.env.SETTLEMENT_SECRET),
          {
            contractId: process.env.SETTLEMENT_CONTRACT,
            operator: stellarPubkey(process.env.SETTLEMENT_SECRET),
            // WORKER_ADDRESS = fallback para forges embedded (sin pubkey propia);
            // sin env cobra el operador mismo (compute propio → self-pay).
            worker: process.env.WORKER_ADDRESS ?? stellarPubkey(process.env.SETTLEMENT_SECRET),
            payout: Number(process.env.PAYOUT_BASE ?? 100000), // $0.01 USDC base
            ...(process.env.PAYOUT_PER_TOKEN ? { perToken: Number(process.env.PAYOUT_PER_TOKEN) } : {}),
          },
          settleJournal,
          // S42 (I4): release del operador falló → el job quedó funded ligado
          // al worker. Se lo avisamos al forge: puede self-claimear on-chain
          // sin depender de que el gateway reintente.
          (p) => {
            forgeWS?.sessions.get(p.worker)?.send({ type: "job.funded", chainJobId: p.jobId, resultHash: p.resultHash });
          },
        ),
      }
    : {}),
});

// S10a: operador fijo por env (público) o efímero impreso (dev local).
// El secreto jamás se loguea cuando viene de env.
const envOperator = process.env.OPERATOR_KEY;
if (envOperator) {
  await apiKeys.seed("operator", envOperator);
  console.log("weaver operador: fijo por OPERATOR_KEY (no se muestra)");
} else {
  const operator = await apiKeys.issue("operator");
  console.log(`weaver operator key (solo esta vez, no la pierdas): ${operator.secret}`);
}

const port = Number(process.env.PORT ?? 3001);
const hostname = process.env.HOST ?? "127.0.0.1";
// S15a: público exige HOST=0.0.0.0 explícito; el default sigue siendo loopback (S11).
const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`weaver-gateway en http://${info.address}:${info.port}`);
  console.log(
    `config: cors=${corsOrigins.length ? corsOrigins.join(",") : "abierto(dev)"} paywall=${payTo ? "ON" : "OFF"} rateLimit=${rpm > 0 ? `${rpm}/min` : "OFF"} settle=${process.env.SETTLEMENT_SECRET ? "ON" : "OFF"} db=${process.env.DATABASE_URL ? "pg" : "mem"}`,
  );
});

// S31 (ADR-0005): forges remotos entran por WS outbound→inbound al gateway.
// Mismo http server, ruta /v1/forge/ws — el upgrade se bifurca ahí adentro.
forgeWS = attachForgeWS(server as HttpServer, {
  registry,
  nonces,
  verify: stellarVerify,
});

// S44 (I3): sweep de escrows pending — un crash entre fund y release deja
// el job en el journal; al boot reintentamos el release (el proof sigue
// válido). Si la tx revierte queda failed y visible — jamás huérfano.
if (process.env.SETTLEMENT_SECRET && process.env.SETTLEMENT_CONTRACT) {
  const contractId = process.env.SETTLEMENT_CONTRACT;
  const submitter = new RpcSubmitter(process.env.SOROBAN_RPC ?? "https://soroban-testnet.stellar.org", process.env.SETTLEMENT_SECRET);
  const operatorAddr = stellarPubkey(process.env.SETTLEMENT_SECRET);
  // El worker fallback (embedded o WORKER_ADDRESS) debe estar registrado o
  // fund_job revierte (ForgeNotFound). Self-register idempotente al boot.
  const fallbackWorker = process.env.WORKER_ADDRESS ?? operatorAddr;
  void registerForge(submitter, contractId, fallbackWorker)
    .then(() => console.log(`worker fallback registrado on-chain: ${fallbackWorker.slice(0, 12)}…`))
    .catch((e) => console.warn("register_forge del worker fallback falló:", e));
  void sweepPendingSettles(submitter, settleJournal, contractId, operatorAddr)
    .then((r) => {
      if (r.released + r.failed > 0) console.log(`settle sweep: ${r.released} released, ${r.failed} failed`);
    })
    .catch((e) => console.warn("settle sweep no corrió:", e));
} else if (process.env.SETTLEMENT_SECRET) {
  console.warn("SETTLEMENT_SECRET sin SETTLEMENT_CONTRACT: settle OFF (fail-closed, sin default de contrato)");
}
