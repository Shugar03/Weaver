// LEGACY — superado por scripts/demo-capture.mjs (apunta a /dashboard,
// puerto :3001 del código, operator key por env). Se conserva como referencia.
// Lo que hacía: valida el loop demo en browser real:
// RUN → stream → DONE → KILL → RUN (failover al sim) → REVIVIR.
// Uso: node scripts/demo.mjs [url]  (gateway :3101 + ollama arriba, web en :3000)
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://localhost:3000";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(base, { waitUntil: "networkidle", timeout: 60000 });

// 1. RUN normal → DONE en ollama-local
await page.getByRole("button", { name: /Run/ }).click();
await page.waitForFunction(() => document.body.innerText.includes("WHY"), undefined, { timeout: 240000 });
await page.screenshot({ path: "/tmp/weaver-run-done.png" });
console.log("run ok");

// 2. fleet con highlight del elegido
await page.locator("#fleet").scrollIntoViewIfNeeded();
await page.waitForTimeout(6000); // espera el poll de 5s
await page.screenshot({ path: "/tmp/weaver-fleet.png" });
console.log("fleet ok");

// 3. KILL → RUN → failover visible al sim
await page.locator("#live").scrollIntoViewIfNeeded();
await page.getByRole("button", { name: /Kill Forge/ }).click();
await page.getByRole("button", { name: /Run/ }).click();
await page.waitForFunction(() => document.body.innerText.includes("forge-sim-01"), undefined, { timeout: 240000 });
await page.screenshot({ path: "/tmp/weaver-failover.png" });
console.log("failover ok");

// 4. revivir para dejar todo sano
await page.getByRole("button", { name: /Revivir Forge/ }).click();
await browser.close();
console.log("demo-shot ok");
