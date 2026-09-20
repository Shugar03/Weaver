// Composition root: forges reales + standby simulado + kill switch.
// - ollama-local: Forge real (Ollama en la Air), HOT mientras vive.
// - forge-sim-01: capacidad SIMULADA (badge SIM en UI) para demo de routing/failover.
// - KILL apaga el primario: el scheduler lo ve COLD caro y el failover salta al sim.
// Env (todo opcional, defaults = dev local idéntico a siempre):
//   PORT, HOST (default 127.0.0.1 — público exige 0.0.0.0 explícito),
//   CORS_ORIGIN (coma-separado; ausente = abierto),
//   OPERATOR_KEY (fija el admin entre reinicios; ausente = efímera impresa),
//   PAYWALL_PAY_TO (presente = paywall x402 ON; ausente = off),
//   RATE_LIMIT_RPM (default 120; 0 = off).
// Uso: `node apps/gateway/src/serve.ts` (dejar corriendo en una terminal).
import { serve } from "@hono/node-server";
import { createApp } from "./index.ts";
import { FailoverForgeExec, FakeForgeExec, OllamaMLXAdapter, SwitchableExec } from "@weaver/forge-exec";
import { InMemoryApiKeys, PostgresApiKeys } from "@weaver/api-keys";
import { FacilitatorVerifier } from "@weaver/settlement";
import { InMemoryTelemetry, PostgresTelemetry } from "@weaver/telemetry";
import { dbFromUrl } from "@weaver/db";
import type { ForgeView } from "@weaver/scheduler";

const primary = new SwitchableExec(new OllamaMLXAdapter({ model: "qwen3:4b" }));
const standby = new FakeForgeExec({ forgeId: "forge-sim-01", model: "qwen3:4b" });

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

function forges(): ForgeView[] {
  if (primary.isDead()) return [{ ...OLLAMA_VIEW, hot: false, queueMs: 99999 }, SIM_VIEW];
  return [OLLAMA_VIEW, SIM_VIEW];
}

const apiKeys = process.env.DATABASE_URL
  ? new PostgresApiKeys(dbFromUrl(process.env.DATABASE_URL))
  : new InMemoryApiKeys();

const corsOrigins = (process.env.CORS_ORIGIN ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const payTo = process.env.PAYWALL_PAY_TO;
const rpm = Number(process.env.RATE_LIMIT_RPM ?? 120);

const app = createApp({
  forges,
  exec: new FailoverForgeExec([primary, standby]),
  chaos: { setDead: (dead: boolean) => primary.setDead(dead) },
  // S9a: historial en memoria = desde el boot (se declara en la UI /forge).
  // S16a: con DATABASE_URL, Postgres (Supabase); sin ella, in-memory (dev).
  telemetry: process.env.DATABASE_URL
    ? new PostgresTelemetry(dbFromUrl(process.env.DATABASE_URL))
    : new InMemoryTelemetry(),
  node: { version: "0.1.0", startedAt: Date.now() },
  apiKeys,
  ...(corsOrigins.length ? { corsOrigins } : {}),
  ...(rpm > 0 ? { rateLimit: { rpm } } : {}),
  // S15a: paywall opt-in por env. Sin PAYWALL_PAY_TO, abierto (dev/demo).
  ...(payTo ? { paywall: { verifier: new FacilitatorVerifier(), payTo } } : {}),
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
serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`weaver-gateway en http://${info.address}:${info.port}`);
  console.log(
    `config: cors=${corsOrigins.length ? corsOrigins.join(",") : "abierto(dev)"} paywall=${payTo ? "ON" : "OFF"} rateLimit=${rpm > 0 ? `${rpm}/min` : "OFF"}`,
  );
});
