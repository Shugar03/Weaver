// Composition root local: forges reales + standby simulado + kill switch.
// - ollama-local: Forge real (Ollama en la Air), HOT mientras vive.
// - forge-sim-01: capacidad SIMULADA (badge SIM en UI) para demo de routing/failover.
// - KILL apaga el primario: el scheduler lo ve COLD caro y el failover salta al sim.
// Sin paywall (bench/dev/demo).
// Uso: `node apps/gateway/src/serve.ts` (dejar corriendo en una terminal).
import { serve } from "@hono/node-server";
import { createApp } from "./index.ts";
import { FailoverForgeExec, FakeForgeExec, OllamaMLXAdapter, SwitchableExec } from "@weaver/forge-exec";
import { InMemoryApiKeys } from "@weaver/api-keys";
import { InMemoryTelemetry } from "@weaver/telemetry";
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

const apiKeys = new InMemoryApiKeys();

const app = createApp({
  forges,
  exec: new FailoverForgeExec([primary, standby]),
  chaos: { setDead: (dead: boolean) => primary.setDead(dead) },
  // S9a: historial en memoria = desde el boot (se declara en la UI /forge).
  telemetry: new InMemoryTelemetry(),
  node: { version: "0.1.0", startedAt: Date.now() },
  apiKeys,
});

// S10a: key de operador impresa UNA vez (entorno local). No commitear, no logear en prod.
const operator = await apiKeys.issue("operator");
console.log(`weaver operator key (solo esta vez, no la pierdas): ${operator.secret}`);

const port = Number(process.env.PORT ?? 3001);
// S11: loopback only. En esta LAN nadie más toca admin ni paga de más.
serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
  console.log(`weaver-gateway en http://localhost:${info.port}`);
});
