// Valida /chat en browser: enviar → thinking → stream → meta FORGE → persistencia.
// Uso: node scripts/chat-test.mjs [url]
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://localhost:3000/chat";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(base, { waitUntil: "networkidle", timeout: 60000 });
await page.getByPlaceholder("Escribe un mensaje...").fill("decí solo: hola");
await page.keyboard.press("Enter");
await page.waitForFunction(() => document.body.innerText.includes("FORGE ollama-local"), { timeout: 240000 });
await page.screenshot({ path: "/tmp/weaver-chat-run.png" });
const recents = await page.evaluate(() => localStorage.getItem("weaver:chat:recents"));
if (!recents || !recents.includes("hola")) throw new Error("sin persistencia en localStorage");
console.log("chat ok: stream + meta + recents persistidos");
await browser.close();
