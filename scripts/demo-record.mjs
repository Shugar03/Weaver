// D1 — Demo video ≤3min: captura REAL del stack corriendo (no animación).
// Cada beat del guion = un contexto playwright con recordVideo 1920×1080 →
// un .webm por escena → concat ffmpeg con el spot 30s de intro.
//
// Pre-requisitos: gateway :3001 (SETTLE_CHAIN=evm, OPERATOR_KEY fija),
// 2 forges remotos arriba, web :3000. Uso:
//   node scripts/demo-record.mjs [--out docs/demo] [--kill-pid PID]
// --kill-pid: PID del forge primario a matar en el beat failover (real).
import { chromium } from "playwright";
import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";

const OUT = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : "docs/demo";
const ONLY = process.argv.includes("--beats") ? process.argv[process.argv.indexOf("--beats") + 1].split(",") : null;
const WEB = process.env.WEB ?? "http://127.0.0.1:3000";
const DOCS = process.env.DOCS ?? "http://127.0.0.1:8901"; // python -m http.server --directory docs
const GW = process.env.GW ?? "http://127.0.0.1:3001";
const KEY = process.env.OPERATOR_KEY ?? "wvr_demo_operator_key_2024";
const KILL_PID = process.argv.includes("--kill-pid") ? Number(process.argv[process.argv.indexOf("--kill-pid") + 1]) : null;
mkdirSync(join(OUT, "segments"), { recursive: true });

const PROMPT = "Explain why decentralized inference needs cryptographic proof in 2 sentences.";

// Job real via API dentro de la página (la UI lo ve vía feeds). maxTokens
// acota el stream — qwen3 es thinking-model y sin cap divaga ~60s.
const fireJob = (page) =>
  page.evaluate(
    async ({ gw, key, prompt }) => {
      const r = await fetch(`${gw}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: "qwen3:4b",
          stream: true,
          max_tokens: 120,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      const t = await r.text();
      return { status: r.status, len: t.length };
    },
    { gw: GW, key: KEY, prompt: PROMPT },
  ).then((r) => console.log(`  job → status ${r.status} (${r.len} chars)`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch();
const ctxOpts = { viewport: { width: 1920, height: 1080 }, recordVideo: { dir: join(OUT, "segments"), size: { width: 1920, height: 1080 } } };
const beats = []; // {file, label}

async function beat(name, fn) {
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  const vidPath = await page.video().path();
  try {
    await fn(page);
  } finally {
    await ctx.close(); // flush del video
  }
  const dest = join(OUT, "segments", `${String(beats.length).padStart(2, "0")}-${name}.webm`);
  renameSync(vidPath, dest);
  beats.push(dest);
  console.log(`beat ${name} → ${dest}`);
}

const want = (n) => !ONLY || ONLY.includes(n);
// 01 · Landing (hook): scroll suave + volver arriba.
if (want("landing")) await beat("landing", async (page) => {
  await page.goto(WEB, { waitUntil: "networkidle" });
  await sleep(1500);
  await page.mouse.wheel(0, 1400);
  await sleep(2500);
  await page.mouse.wheel(0, -1400);
  await sleep(2000);
});

// 02 · /network + job real: pipeline FIRE→ROUTE→EXECUTE→SETTLE en vivo.
if (want("network-job")) await beat("network-job", async (page) => {
  await page.goto(`${WEB}/network`, { waitUntil: "networkidle" });
  await sleep(2000);
  await fireJob(page);
  await sleep(9000); // el stream + el feed settle se ven en vivo
  await page.mouse.wheel(0, 1200); // bajar al settle feed / ledger
  await sleep(5000);
});

// 03 · Failover real: /forge muestra la fleet → SIGINT al forge primario
// → el row muere (TTL) → job rutea al standby → settle feed lo evidencia.
if (want("failover")) await beat("failover", async (page) => {
  await page.goto(`${WEB}/forge`, { waitUntil: "networkidle" });
  await sleep(3000);
  if (KILL_PID) {
    process.kill(KILL_PID, "SIGINT");
    console.log(`  kill -SIGINT forge primario (pid ${KILL_PID})`);
  }
  await sleep(4000); // el row de live1 empieza a morir en la tabla
  await page.goto(`${WEB}/network`, { waitUntil: "networkidle" });
  await fireJob(page);
  await sleep(12000); // failover mid-flight o pre-dispatch → standby sirve
  await page.mouse.wheel(0, 1200);
  await sleep(5000);
});

// 04 · On-chain receipts: los explorers tienen bot-wall para headless —
// docs/demo/receipt.html consulta el RPC público desde el browser y renderiza
// Released+Transfer reales. Muestra las 2 últimas settle txs del ledger.
if (want("receipt")) await beat("receipt", async (page) => {
  const execs = await fetch(`${GW}/v1/executions?limit=6`)
    .then((r) => (r.ok ? r.json() : []))
    .catch(() => []);
  const txs = execs.map((e) => e.settle?.releaseTx).filter(Boolean).slice(0, 2);
  for (const tx of txs.length ? txs : [null]) {
    if (tx) {
      await page.goto(`${DOCS}/demo/receipt.html?tx=${tx}`, { waitUntil: "networkidle" });
      await sleep(7000);
    }
  }
});

// 05 · /security — ZDR cierre.
if (want("security")) await beat("security", async (page) => {
  await page.goto(`${WEB}/security`, { waitUntil: "networkidle" });
  await sleep(3000);
  await page.mouse.wheel(0, 900);
  await sleep(5000);
});

await browser.close();
console.log(`\n${beats.length} segmentos en ${OUT}/segments — ensamblar con:`);
console.log(`  ffmpeg -i docs/launch/weaver-launch-en.mp4 + segments → docs/demo/weaver-demo.mp4`);
