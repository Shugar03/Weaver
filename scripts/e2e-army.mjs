// e2e-army — batería E2E completa: levanta gateway efímero (:3601, embedded
// forges, memoria, sin settle/paywall) + web efímera (:3310) y prueba todo lo
// testeable sin credenciales externas. Determinista donde se puede, live donde
// importa (chat real contra Ollama, failover real vía kill).
// Uso: node scripts/e2e-army.mjs [--keep] [--headed] [--only nombre]
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const GW_PORT = 3601;
const WEB_PORT = 3310;
const GW = `http://127.0.0.1:${GW_PORT}`;
const WEB = `http://127.0.0.1:${WEB_PORT}`;
const OPERATOR_KEY = "wvr_e2e_army_operator";
// Worker fijo de test (secp256k1 válido — key=1): los forges embedded firman
// proofs L0 con ella y el ProofChip puede verificar client-side.
const WORKER_SECRET = "0x" + "0".repeat(63) + "1";
const KEEP = process.argv.includes("--keep");
const HEADED = process.argv.includes("--headed");
const ONLY = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const results = [];
const t = async (name, fn) => {
  if (ONLY && !name.includes(ONLY)) return;
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`  ✔ ${name} (${Date.now() - t0}ms)`);
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t0, err: e.message });
    console.log(`  ✖ ${name} — ${e.message?.slice(0, 160)}`);
  }
};
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const assertJson = async (r, status = 200) => {
  if (r.status !== status) {
    const body = await r.text().catch(() => "");
    throw new Error(`HTTP ${r.status} (esperado ${status}) — ${body.slice(0, 120)}`);
  }
  return r.json();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, { timeout = 60_000, step = 500, label } = {}) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timeout esperando ${label}`);
    await sleep(step);
  }
};

// — levanta el stack efímero —
const procs = [];
const cleanup = () => {
  if (!KEEP) for (const p of procs) p.kill("SIGTERM");
};
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));
process.on("unhandledRejection", (e) => {
  console.error("fallo fatal:", e?.message ?? e);
  process.exit(1);
});
const spawnLogged = (cmd, args, opts, logFile) => {
  const out = openSync(logFile, "w");
  const p = spawn(cmd, args, { ...opts, stdio: ["ignore", out, out], env: { ...process.env, ...opts.env } });
  procs.push(p);
  return p;
};

console.log("── levantando stack efímero ──");
// preflight: un zombie de una corrida anterior ocuparía el puerto y los tests
// correrían contra env/code viejos (falsos 401, falsos pass). Fallar rápido.
for (const [port, name] of [[GW_PORT, "gateway"], [WEB_PORT, "web"]]) {
  const inUse = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) })
    .then((r) => r.status > 0)
    .catch(() => false);
  if (inUse) {
    console.error(`✖ puerto ${port} ocupado (${name}) — matá el proceso huérfano o corré con otros puertos`);
    process.exit(1);
  }
}
const gwEnv = {
  PORT: String(GW_PORT),
  HOST: "127.0.0.1",
  OPERATOR_KEY,
  WORKER_SECRET,
  // determinista: memoria, embedded forges, sin settle ni paywall ni indexer
  DATABASE_URL: "",
  INDEXER_DATABASE_URL: "",
  SETTLEMENT_SECRET: "",
  PAYWALL_PAY_TO: "",
  REMOTE_ONLY: "",
  SETTLE_CHAIN: "evm",
};
spawnLogged("npx", ["tsx", "apps/gateway/src/serve.ts"], { cwd: ROOT, env: gwEnv }, "/tmp/e2e-army-gw.log");
await waitFor(async () => (await fetch(`${GW}/v1/forges`)).ok, { timeout: 60_000, label: "gateway /v1/forges" });
console.log("gateway :3601 arriba");

// next dev es singleton por proyecto — si el usuario tiene uno corriendo,
// choca. E2E corre contra `next build && next start`: se prueba lo que
// shipea (prod render, sin HMR), y el puerto queda libre para elegir.
const build = spawn("npx", ["next", "build"], {
  cwd: `${ROOT}apps/web`,
  env: { ...process.env, WEAVER_GATEWAY: GW },
  stdio: ["ignore", openSync("/tmp/e2e-army-web.log", "w"), 2],
});
await new Promise((res, rej) => build.on("exit", (c) => (c === 0 ? res() : rej(new Error(`next build exit ${c}`)))));
spawnLogged("npx", ["next", "start", "-p", String(WEB_PORT)], {
  cwd: `${ROOT}apps/web`,
  env: { WEAVER_GATEWAY: GW },
}, "/tmp/e2e-army-web.log");
await waitFor(async () => (await fetch(WEB)).ok, { timeout: 60_000, label: "web /" });
console.log(`web :${WEB_PORT} arriba`);

const browser = await chromium.launch({ headless: !HEADED });
const newPage = async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  return ctx.newPage();
};

// ═══ A · superficie API ═══
console.log("\n── A · API ──");
await t("GET /v1/models lista modelos", async () => {
  const j = await assertJson(await fetch(`${GW}/v1/models`));
  const ids = (j.data ?? j).map((m) => m.id ?? m);
  assert(ids.includes("qwen3:4b"), `qwen3:4b ausente: ${JSON.stringify(ids)}`);
});
await t("GET /v1/forges lista embedded fleet", async () => {
  const j = await assertJson(await fetch(`${GW}/v1/forges`));
  const ids = j.map((f) => f.forgeId);
  assert(ids.includes("ollama-local"), `ollama-local ausente: ${ids}`);
  assert(ids.includes("forge-sim-01"), `forge-sim-01 ausente: ${ids}`);
});
await t("chat non-stream devuelve chat.completion", async () => {
  const j = await assertJson(await fetch(`${GW}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "qwen3:4b", messages: [{ role: "user", content: "decí: ok" }], max_tokens: 8 }),
  }), 200);
  assert(j.object === "chat.completion", `object=${j.object}`);
  assert(j.choices?.[0]?.message?.content !== undefined, "sin message.content");
});
await t("chat stream emite SSE + [DONE]", async () => {
  const r = await fetch(`${GW}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "qwen3:4b", messages: [{ role: "user", content: "decí: ok" }], stream: true, max_tokens: 8 }),
  });
  assert(r.status === 200, `HTTP ${r.status}`);
  const text = await r.text();
  assert(text.includes("chat.completion.chunk"), "sin chunks SSE");
  assert(text.includes("[DONE]"), "sin [DONE]");
  assert(text.includes("weaver_proof") || text.includes('"usage"'), "sin frame final");
});
await t("key trucha → 401", async () => {
  const r = await fetch(`${GW}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer wvr_trucha" },
    body: JSON.stringify({ model: "qwen3:4b", messages: [{ role: "user", content: "x" }] }),
  });
  assert(r.status === 401, `HTTP ${r.status}`);
});
await t("OPERATOR_KEY keyed chat → 200 (operator bypass billing)", async () => {
  const r = await fetch(`${GW}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${OPERATOR_KEY}` },
    body: JSON.stringify({ model: "qwen3:4b", messages: [{ role: "user", content: "decí: ok" }], max_tokens: 4 }),
  });
  assert(r.status === 200, `HTTP ${r.status}`);
});
await t("/v1/network/stats → 404 honesto sin indexer", async () => {
  const r = await fetch(`${GW}/v1/network/stats`);
  assert(r.status === 404, `HTTP ${r.status} — sin indexer debe ser 404, no 200 inventado`);
});
await t("/v1/executions lista samples", async () => {
  const j = await assertJson(await fetch(`${GW}/v1/executions`));
  assert(Array.isArray(j), "no es array");
  assert(j.length > 0, "sin samples tras los chats");
  assert(j[0].forgeId !== undefined, "sample sin forgeId");
});
await t("/v1/usage keyed devuelve métricas del key", async () => {
  const r = await fetch(`${GW}/v1/usage`, { headers: { authorization: `Bearer ${OPERATOR_KEY}` } });
  const j = await assertJson(r);
  assert(j.jobs >= 1, `jobs=${j.jobs} — el chat keyed anterior debió contar`);
});
await t("/v1/admin/kill sin key → 401", async () => {
  const r = await fetch(`${GW}/v1/admin/kill`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert(r.status === 401, `HTTP ${r.status}`);
});

// ═══ B · browser core ═══
console.log("\n── B · browser ──");
await t("landing / renderiza con nav", async () => {
  const page = await newPage();
  await page.goto(WEB, { waitUntil: "networkidle", timeout: 60_000 });
  const body = await page.textContent("body");
  assert(/weaver/i.test(body), "landing sin marca weaver");
  await page.close();
});
await t("/chat: enviar → stream → FORGE meta visible", async () => {
  const page = await newPage();
  await page.goto(`${WEB}/chat`, { waitUntil: "networkidle", timeout: 60_000 });
  await page.getByPlaceholder("Escribe un mensaje...").fill("decí solo: ok");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => /FORGE\s/.test(document.body.innerText), undefined, { timeout: 180_000 });
  const forge = await page.evaluate(() => document.body.innerText.match(/FORGE\s+(\S+)/)?.[1]);
  assert(forge, "FORGE meta ausente");
  console.log(`    ↳ served by ${forge}`);
  await page.close();
});
await t("/chat: PROOF chip verifica (PROOF ✓)", async () => {
  const page = await newPage();
  await page.goto(`${WEB}/chat`, { waitUntil: "networkidle", timeout: 60_000 });
  await page.getByPlaceholder("Escribe un mensaje...").fill("decí solo: ok");
  await page.keyboard.press("Enter");
  // WORKER_SECRET está set → embedded firma → el chip debe verificar client-side
  await page.waitForFunction(() => document.body.innerText.includes("PROOF ✓"), undefined, { timeout: 180_000 });
  await page.close();
});
await t("/chat: kill ollama-local → sim sirve y NO inventa badge failover", async () => {
  // spec 014 end-to-end (caso honesto): el forge matado queda último en el
  // orden (queueMs=99999) — sim sirve directo, no hay intento fallido, así
  // que el badge NO debe aparecer (jamás metadata de ruta inventada).
  const kill = await fetch(`${GW}/v1/admin/kill`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${OPERATOR_KEY}` },
    body: JSON.stringify({ forgeId: "ollama-local", dead: true }),
  });
  assert(kill.ok, `kill HTTP ${kill.status}`);
  const page = await newPage();
  try {
    await page.goto(`${WEB}/chat`, { waitUntil: "networkidle", timeout: 60_000 });
    await page.getByPlaceholder("Escribe un mensaje...").fill("decí solo: ok");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => /FORGE\s/.test(document.body.innerText), undefined, { timeout: 60_000 });
    const txt = await page.evaluate(() => document.body.innerText);
    const forge = txt.match(/FORGE\s+(\S+)/)?.[1];
    assert(forge === "forge-sim-01", `sirvió ${forge} — esperaba forge-sim-01 con ollama-local muerto`);
    assert(!txt.includes("FAILOVER"), "badge FAILOVER apareció sin intento fallido — metadata inventada");
  } finally {
    await fetch(`${GW}/v1/admin/kill`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${OPERATOR_KEY}` },
      body: JSON.stringify({ forgeId: "ollama-local", dead: false }),
    });
    await page.close();
  }
});
await t("/dashboard: fleet table lista forges reales", async () => {
  const page = await newPage();
  await page.goto(`${WEB}/dashboard`, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForFunction(() => document.body.innerText.includes("ollama-local"), undefined, { timeout: 30_000 });
  const txt = await page.evaluate(() => document.body.innerText);
  assert(txt.includes("forge-sim-01"), "sim ausente en fleet table");
  await page.close();
});
await t("/dashboard: botón KILL funciona desde la UI", async () => {
  const page = await newPage();
  await page.addInitScript((k) => localStorage.setItem("weaver:operator-key", k), OPERATOR_KEY);
  await page.goto(`${WEB}/dashboard`, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForFunction(() => document.body.innerText.includes("ollama-local"), undefined, { timeout: 30_000 });
  const btn = page.getByRole("button", { name: "KILL" }).first();
  await btn.click();
  await page.waitForFunction(() => document.body.innerText.includes("REVIVE"), undefined, { timeout: 15_000 });
  // revive para dejar la fleet sana
  await page.getByRole("button", { name: "REVIVE" }).first().click();
  await page.close();
});
await t("/network: stats strip muestra estado honesto (indexer off)", async () => {
  const page = await newPage();
  await page.goto(`${WEB}/network`, { waitUntil: "networkidle", timeout: 60_000 });
  const txt = await page.evaluate(() => document.body.innerText);
  assert(/network|indexer|offline|unavailable|—/i.test(txt), "network page vacía/crasheada");
  assert(!txt.includes("Application error"), "error boundary disparado");
  await page.close();
});
await t("/forge índice lista forges + /forge/[id] detalle", async () => {
  const page = await newPage();
  await page.goto(`${WEB}/forge`, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForFunction(() => document.body.innerText.includes("ollama-local"), undefined, { timeout: 30_000 });
  await page.goto(`${WEB}/forge/ollama-local`, { waitUntil: "networkidle", timeout: 60_000 });
  const txt = await page.evaluate(() => document.body.innerText);
  assert(txt.includes("ollama-local"), "detalle sin forgeId");
  await page.close();
});
await t("/account renderiza panel de login", async () => {
  const page = await newPage();
  await page.goto(`${WEB}/account`, { waitUntil: "networkidle", timeout: 60_000 });
  const txt = await page.evaluate(() => document.body.innerText);
  assert(/cuenta|account|passkey|wallet|conectar|login/i.test(txt), "account vacío");
  await page.close();
});
for (const [route, marker] of [
  ["/models", /model/i],
  ["/security", /secur|zdr|proof|sig/i],
  ["/developers", /develop|api|sdk|key/i],
]) {
  await t(`${route} renderiza`, async () => {
    const page = await newPage();
    await page.goto(`${WEB}${route}`, { waitUntil: "networkidle", timeout: 60_000 });
    const txt = await page.evaluate(() => document.body.innerText);
    assert(marker.test(txt) && txt.length > 200, `${route} vacío o crasheado`);
    await page.close();
  });
}

// ═══ reporte ═══
const pass = results.filter((r) => r.ok).length;
const fail = results.filter((r) => !r.ok);
console.log(`\n══ resultado: ${pass}/${results.length} ══`);
for (const f of fail) console.log(`  ✖ ${f.name} — ${f.err}`);
if (!KEEP) for (const p of procs) p.kill("SIGTERM");
await browser.close();
process.exit(fail.length ? 1 : 0);
