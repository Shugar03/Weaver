// pnpm shot — screenshots del dashboard a /tmp (requiere `next dev` en :3000).
// Uso: node scripts/shot.mjs [url]  (default http://localhost:3000)
import { chromium } from "playwright";

const url = process.argv[2] ?? "http://localhost:3000";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
await page.screenshot({ path: "/tmp/weaver-dash.png" });
await page.screenshot({ path: "/tmp/weaver-dash-full.png", fullPage: true });
await browser.close();
console.log("shots en /tmp/weaver-dash.png y /tmp/weaver-dash-full.png");
