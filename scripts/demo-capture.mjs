// pnpm demo:capture — 3 tomas deterministas para el video del Checkpoint 1.
// Toma 1: RUN corto → DONE en ollama-local. Toma 2: fleet. Toma 3: KILL → RUN (failover al sim) → REVIVIR.
// Requiere: gateway arriba (`node apps/gateway/src/serve.ts`, default :3001),
// ollama serve con qwen3:4b (ideal: OLLAMA_KEEP_ALIVE=30m + 1 RUN previo de calentamiento),
// web en :3000, y OPERATOR_KEY con la key que imprimió el gateway al arrancar.
// Uso: OPERATOR_KEY=wvr_... node scripts/demo-capture.mjs [webUrl]
// Reemplaza a demo.mjs (legacy: apuntaba a `/`, puerto viejo, sin operator key).
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

const PROMPT = "decí solo: hola Weaver";
const OPERATOR_KEY = process.env.OPERATOR_KEY;
if (!OPERATOR_KEY) {
  console.error("falta OPERATOR_KEY — copiala del log del gateway (`weaver operator key ...`)");
  process.exit(1);
}

const base = process.argv[2] ?? "http://localhost:3000";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript((key) => {
  try {
    localStorage.setItem("weaver:operator-key", key);
  } catch {
    /* sin storage: el kill fallará con 401 y el failover no se ve */
  }
}, OPERATOR_KEY);
await page.goto(`${base}/dashboard`, { waitUntil: "networkidle", timeout: 60000 });

// El scope es #live a propósito: #fleet ya lista "ollama-local" y "forge-sim-01"
// desde el SSR y un wait sobre body resolvería instantáneo (falso verde).
const liveHas = (text) =>
  page.waitForFunction(
    (t) => document.querySelector("#live")?.textContent?.includes(t) ?? false,
    text,
    { timeout: 240000 },
  );

// 1. RUN corto → DONE en ollama-local
await page.locator("#live").scrollIntoViewIfNeeded();
await page.locator("#live textarea").fill(PROMPT);
await page.getByRole("button", { name: /^Run$/ }).click();
await liveHas("FORGE ollama-local");
await page.screenshot({ path: "/tmp/weaver-take1-run.png" });
console.log("take 1 ok: run → ollama-local");

// 2. fleet con highlight del elegido
await page.locator("#fleet").scrollIntoViewIfNeeded();
await page.waitForTimeout(6000); // espera el poll de 5s
await page.screenshot({ path: "/tmp/weaver-take2-fleet.png" });
console.log("take 2 ok: fleet");

// 3. KILL → RUN → failover visible al sim → revivir para dejar todo sano
await page.locator("#live").scrollIntoViewIfNeeded();
await page.getByRole("button", { name: /Kill Forge/ }).click();
await page.locator("#live textarea").fill(PROMPT);
await page.getByRole("button", { name: /^Run$/ }).click();
await liveHas("forge-sim-01");
await page.screenshot({ path: "/tmp/weaver-take3-failover.png" });
console.log("take 3 ok: failover → forge-sim-01");
await page.getByRole("button", { name: /Revivir Forge/ }).click();
await browser.close();

// Links para el beat 3 del guion (docs/demo-guion.md) — impresos, no tipeados en cámara.
try {
  const dep = JSON.parse(
    await readFile(new URL("../contracts/weaver-escrow/deployments/testnet.json", import.meta.url), "utf8"),
  );
  const ex = "https://stellar.expert/explorer/testnet";
  console.log(`fund:     ${ex}/tx/${dep.txs.fund_job_1}`);
  console.log(`release:  ${ex}/tx/${dep.txs.release_job_1}`);
  console.log(`contract: ${ex}/contract/${dep.contract_id}`);
} catch {
  console.log("(sin deployments/testnet.json: el beat Stellar se muestra a mano)");
}
console.log("demo-capture ok");
