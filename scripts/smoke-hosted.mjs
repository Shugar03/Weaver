#!/usr/bin/env node
// Spec 007 — smoke test de un gateway Weaver público.
// Uso: node scripts/smoke-hosted.mjs <base-url>
// Falla (exit≠0) si algo no es real: forges, un job chat, telemetría.
const base = process.argv[2]?.replace(/\/$/, "");
if (!base) {
  console.error("uso: node scripts/smoke-hosted.mjs <base-url>");
  process.exit(2);
}

const get = async (p) => (await fetch(`${base}${p}`)).json();
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

// 1. Forges vivos
const forges = await get("/v1/forges");
check("GET /v1/forges", Array.isArray(forges), `${forges.length} forges`);
const hot = forges.filter((f) => f.hot);
check("fleet HOT", hot.length > 0, hot.map((f) => `${f.forgeId}:${f.model}`).join(", "));

// 2. Un job real por la URL pública (marco ts para encontrar SU exec después)
const t0 = Date.now();
const model = hot[0]?.model ?? forges[0]?.model;
if (model) {
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, stream: false, messages: [{ role: "user", content: "di OK" }], max_tokens: 8 }),
  });
  check("POST /v1/chat/completions", r.status === 200, `HTTP ${r.status}`);
  if (r.status === 200) {
    const d = await r.json();
    check("contenido inferencia", (d.choices?.[0]?.message?.content ?? "").length > 0);
  }
}

// 3. Telemetría: la exec de ESTE run (ts >= t0, no una vieja) con settle en
// estado terminal — el settle es async post-serve, hay que esperarlo.
let mine;
for (let i = 0; i < 30 && (!mine || !mine.settle || mine.settle.status === "pending"); i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const execs = await get("/v1/executions");
  if (i === 0) check("GET /v1/executions", Array.isArray(execs) && execs.length > 0, `${execs.length} execs`);
  mine = Array.isArray(execs) ? execs.find((e) => e.ts >= t0) : undefined;
}
check("telemetría real de este job", mine && mine.ttftMs > 0, mine ? `ttft=${mine.ttftMs}ms` : "exec no apareció en 90s");
check("settle terminal y exitoso", mine?.settle?.status === "settled",
  mine?.settle ? `status=${mine.settle.status}` : "sin registro de settle");

const failed = results.filter((r) => !r).length;
console.log(failed === 0 ? `\nSMOKE PASS — ${base} es un gateway Weaver real` : `\nSMOKE FAIL — ${failed} checks`);
process.exit(failed === 0 ? 0 : 1);
