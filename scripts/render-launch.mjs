// node scripts/render-launch.mjs [es|en] [out.mp4]
// Re-render determinista del launch film: playwright busca ?render → __seek(t)
// por frame (60fps, 30s) → PNG → ffmpeg image2pipe → libx264; el audio sale de
// __renderAudio() (OfflineAudioContext — mismo graph que la reproducción live).
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";

const FPS = 60, DUR = 30, FRAMES = DUR * FPS + 1;
const LANG = process.argv[2] ?? "es";
const OUT = process.argv[3] ?? `docs/launch/weaver-launch${LANG === "es" ? "" : `-${LANG}`}.mp4`;
const WAV = `/tmp/weaver-launch-${LANG}.wav`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on("pageerror", (e) => console.error("pageerror:", e.message));
await page.goto(`file://${process.cwd()}/docs/launch/index.html?render&lang=${LANG}`, { waitUntil: "networkidle" });
await page.waitForFunction(() => window.__seek && window.__renderAudio, null, { timeout: 60_000 });

const b64 = await page.evaluate(() => window.__renderAudio());
await writeFile(WAV, Buffer.from(b64, "base64"));
console.log(`audio → ${WAV}`);

const ff = spawn("ffmpeg", [
  "-y", "-f", "image2pipe", "-framerate", String(FPS), "-i", "pipe:0",
  "-i", WAV, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "medium",
  "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", OUT,
]);
ff.stderr.on("data", (d) => { const s = String(d); if (/error|invalid/i.test(s)) process.stderr.write(s); });
const done = new Promise((res, rej) => { ff.on("close", (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exit ${c}`)))); });

const paint = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
for (let f = 0; f < FRAMES; f++) {
  await page.evaluate((t) => window.__seek(t), f / FPS);
  await paint();
  ff.stdin.write(await page.screenshot({ type: "png" }));
  if (f % 300 === 0) console.log(`frame ${f}/${FRAMES}`);
}
ff.stdin.end();
await done;
await browser.close();
console.log(`→ ${OUT}`);
