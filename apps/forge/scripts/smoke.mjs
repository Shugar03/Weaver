// Smoke e2e S31: daemon falso contra el gateway vivo.
// challenge REST → WS auth (firma ed25519 del nonce) → heartbeat →
// /v1/forges muestra la instance remota → chat real rutea a ella →
// job.assign por WS → chunks+done firmados → stream llega al cliente.
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import WebSocket from "ws";

// stellar-sdk no es dep directa del gateway — resolvemos en contexto de
// @weaver/settlement (pnpm strict).
const req = createRequire(new URL("../../../packages/settlement/package.json", import.meta.url));
const { Keypair } = req("@stellar/stellar-sdk");

const base = "http://127.0.0.1:3001";
const kp = Keypair.random();
console.log("1) forge pubkey:", kp.publicKey());

const ch = await (await fetch(`${base}/v1/forges/challenge`, { method: "POST" })).json();
console.log("2) nonce:", ch.nonce.slice(0, 16) + "…");

const ws = new WebSocket("ws://127.0.0.1:3001/v1/forge/ws");
await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
ws.send(JSON.stringify({
  type: "auth",
  pubkey: kp.publicKey(),
  nonce: ch.nonce,
  signature: Buffer.from(kp.sign(Buffer.from(ch.nonce, "utf8"))).toString("hex"),
}));

ws.on("message", (d) => console.log("   ws<-", d.toString()));
ws.on("close", (code, reason) => console.log("   ws closed:", code, reason.toString()));
const authed = await new Promise((res) => {
  ws.once("message", (d) => res(JSON.parse(d).type === "auth.ok"));
  setTimeout(() => res(false), 3000);
});
console.log("3) auth.ok:", authed);
if (!authed) throw new Error("auth rechazado");

// El handler de jobs va ANTES del heartbeat: la attestation dispara un
// job.assign apenas la instance aparece — si no respondemos, cuelga y el
// forge queda attested:false para siempre.
let gotAssign = false;
ws.on("message", (d) => {
  const m = JSON.parse(d);
  if (m.type === "ping") return ws.send(JSON.stringify({ type: "pong", t: m.t }));
  if (m.type === "job.assign") {
    const isAttest = m.jobId.startsWith("attest-");
    if (!isAttest) gotAssign = true;
    console.log(isAttest ? "   attestation job:" : "5) job.assign:", m.jobId, "| model:", m.model);
    ws.send(JSON.stringify({ type: "job.ack", jobId: m.jobId }));
    const out = isAttest ? "ok" : "Hola — esto viajó desde el forge remoto por WS.";
    let i = 0;
    const tick = setInterval(() => {
      if (i < out.length) {
        ws.send(JSON.stringify({ type: "job.chunk", jobId: m.jobId, token: out[i++] }));
      } else {
        clearInterval(tick);
        const hash = createHash("sha256").update(out, "utf8").digest();
        ws.send(JSON.stringify({
          type: "job.done",
          jobId: m.jobId,
          resultHash: hash.toString("hex"),
          signature: Buffer.from(kp.sign(hash)).toString("hex"),
          stats: { promptTokens: 5, genTokens: 12, prefillMs: 10, decodeMs: 100 },
        }));
      }
    }, 15);
  }
});

ws.send(JSON.stringify({
  type: "heartbeat",
  instances: [{
    instanceId: "smoke-remote-01",
    model: "remote-only:7b",
    capability: "text",
    hot: true,
    inFlight: 0,
    saturated: false,
    tokPerSec: 60,
    loadTimeMs: 3000,
  }],
}));

// Esperar attested:true — el gateway corre un job real contra el forge.
let mine;
const deadline = Date.now() + 10_000;
for (;;) {
  await new Promise((r) => setTimeout(r, 400));
  const forges = await (await fetch(`${base}/v1/forges`)).json();
  mine = forges.find((f) => f.forgeId === "smoke-remote-01");
  if (mine?.attested === true || Date.now() > deadline) break;
}
console.log("4) /v1/forges →", JSON.stringify(mine));
if (!mine?.remote) throw new Error("la instance remota no aparece ruteable");
if (mine.attested !== true) throw new Error("la attestation no pasó — instance fuera de routing");

const resp = await fetch(`${base}/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "remote-only:7b", messages: [{ role: "user", content: "di hola" }], stream: true, max_tokens: 30 }),
});
const text = await resp.text();
// Los tokens llegan un char por SSE frame — hay que joinear los deltas.
const joined = [...text.matchAll(/^data: (.+)$/gm)]
  .map((l) => { try { return JSON.parse(l[1]); } catch { return null; } })
  .map((f) => f?.choices?.[0]?.delta?.content ?? "")
  .join("");
console.log("   output:", JSON.stringify(joined));
console.log("6) chat status:", resp.status, "| job.assign recibido:", gotAssign,
  "| output remoto completo:", joined.includes("forge remoto por WS"));
ws.close();
process.exit(resp.status === 200 && gotAssign && joined.includes("forge remoto por WS") ? 0 : 1);
