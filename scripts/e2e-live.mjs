// e2e-live — smoke end-to-end REAL sobre Monad testnet: gateway + forge
// remotos en proceso, un job servido, y verificación ON-CHAIN del loop
// completo (attestation → release escrow → feedback ERC-8004). Es el runner
// del demo ≤3min y el smoke test pre-submission — imprime links MonadVision.
//
// Requiere (env, jamás hardcodeado):
//   SETTLEMENT_SECRET  key del operador (fondea/libera) — con USDC + MON
//   FORGE_SECRET       key secp256k1 del forge (0x… privkey)
//   FORGE_CONFIG       path al forge.json (default /tmp/forge-e2e.json)
// Opcional: GATEWAY_PORT (default 3401), MODEL (default qwen3:4b),
//           ESCROW (default deployments/testnet.json → contracts.evm.escrow)
//
// Uso: SETTLEMENT_SECRET=0x… FORGE_SECRET=0x… node scripts/e2e-live.mjs
// Exit 0 = loop verificado on-chain; exit 1 = algo falló (con etapa en log).
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.GATEWAY_PORT ?? 3401);
const BASE = `http://127.0.0.1:${PORT}`;
const RPC = process.env.EVM_RPC_URL ?? "https://testnet-rpc.monad.xyz";
const EXPLORER = "https://testnet.monadvision.com";
const MODEL = process.env.MODEL ?? "qwen3:4b";
const SECRET = process.env.SETTLEMENT_SECRET;
const FORGE_SECRET = process.env.FORGE_SECRET;
const FORGE_CONFIG = process.env.FORGE_CONFIG ?? "/tmp/forge-e2e.json";

if (!SECRET || !FORGE_SECRET) {
  console.error("faltan SETTLEMENT_SECRET / FORGE_SECRET — ver header del script");
  process.exit(1);
}

const dep = JSON.parse(await readFile(join(ROOT, "contracts/weaver-escrow-evm/deployments/testnet.json"), "utf8"));
const ESCROW = process.env.ESCROW ?? dep.contract_id;
const CREDITS = dep.credits_contract;
const USDC = dep.token_usdc;

const kids = [];
const log = (tag, s) => process.stdout.write(`  [${tag}] ${s}`);
function run(tag, cmd, args, env) {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  p.stdout.on("data", (d) => log(tag, String(d)));
  p.stderr.on("data", (d) => log(`${tag}!`, String(d)));
  kids.push(p);
  return p;
}
const die = async (msg) => {
  console.error(`\nE2E FAIL — ${msg}`);
  for (const k of kids) k.kill("SIGTERM");
  process.exit(1);
};

const get = async (path) => {
  const r = await fetch(`${BASE}${path}`);
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
};
const rpc = (method, params) =>
  fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })
    .then((r) => r.json())
    .then((j) => {
      if (j.error) throw new Error(`${method}: ${j.error.message}`);
      return j.result;
    });

console.log(`e2e-live: escrow ${ESCROW} · rpc ${RPC} · model ${MODEL}\n`);

// 1. Forge config directo con la key pre-fondeada (init generaría una nueva
// sin gas). Derivo la address con viem dentro de apps/forge (deps allí).
const { stdout: addrOut } = await new Promise((res, rej) => {
  const p = spawn("pnpm", ["--dir", "apps/forge", "exec", "node", "--experimental-strip-types", "-e",
    `import {privateKeyToAccount} from 'viem/accounts';console.log(privateKeyToAccount('${FORGE_SECRET}').address)`]);
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  p.on("exit", (c) => (c === 0 ? res({ stdout: out }) : rej(new Error("derive address falló"))));
});
const forgeAddr = addrOut.trim();
// Preservo agentId de un run anterior — re-registrar mintearía un agente
// nuevo cada vez (spam en el registry + gas).
let prevAgentId;
try {
  prevAgentId = JSON.parse(await readFile(FORGE_CONFIG, "utf8")).agentId;
} catch {}
await mkdir(dirname(FORGE_CONFIG), { recursive: true });
await writeFile(
  FORGE_CONFIG,
  JSON.stringify(
    {
      chain: "evm",
      pubkey: forgeAddr,
      secret: FORGE_SECRET,
      gateway: BASE,
      instances: [{ instanceId: `live-${Date.now() % 100000}`, model: MODEL, capability: "text", maxConcurrent: 4, loadTimeMs: 4000 }],
      ...(prevAgentId !== undefined ? { agentId: prevAgentId } : {}),
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
console.log(`forge ${forgeAddr} (key pre-fondeada — debe tener MON para gas)`);

// 2. Gateway con settlement EVM + forge daemon (registra escrow + ERC-8004).
run("gateway", "pnpm", ["--dir", "apps/gateway", "exec", "node", "--experimental-strip-types", "src/serve.ts"], {
  PORT: String(PORT),
  REMOTE_ONLY: "1",
  SETTLE_CHAIN: "evm",
  SETTLEMENT_SECRET: SECRET,
  SETTLEMENT_CONTRACT: ESCROW,
  EVM_USDC: USDC,
  EVM_CREDITS: CREDITS,
  EVM_RPC_URL: RPC,
});
run("forge", "pnpm", ["--dir", "apps/forge", "exec", "node", "--experimental-strip-types", "src/cli.ts", "up", "--config", FORGE_CONFIG, "--contract", ESCROW]);
await new Promise((r) => setTimeout(r, 5000));

// 3. Esperar attestation (el forge corre un benchmark real).
console.log("esperando attestation…");
let forge;
{
  const deadline = Date.now() + 180_000;
  for (;;) {
    try {
      const list = await get("/v1/forges");
      forge = list.find((f) => f.remote);
      if (forge?.attested) break;
    } catch {}
    if (Date.now() > deadline) await die("forge nunca attestó (¿Ollama con el modelo?)");
    await new Promise((r) => setTimeout(r, 3000));
  }
}
console.log(`attested ✓ forge=${forge.forgeId} agent=${forge.forgeAgentId ?? "—"} verified=${forge.forgeAgentVerified ?? "—"}`);

// 4. Job real.
console.log("enviando job…");
const res = await fetch(`${BASE}/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: MODEL, stream: true, messages: [{ role: "user", content: "Reply with exactly: ok" }] }),
});
const stream = await res.text();
if (res.status !== 200 || !stream.includes("data:")) {
  console.error(`chat → ${res.status}, body:\n${stream.slice(0, 400)}`);
  await die("stream sin chunks data:");
}

// 5. Esperar el sample con releaseTx.
console.log("esperando settle…");
let exec;
{
  const deadline = Date.now() + 120_000;
  for (;;) {
    const list = await get("/v1/executions");
    exec = list.find((e) => e.forgeId === forge.forgeId && e.settle?.status === "settled");
    if (exec) break;
    if (Date.now() > deadline) await die("settle nunca llegó");
    await new Promise((r) => setTimeout(r, 3000));
  }
}
console.log(`settled ✓ jobId=${exec.settle.jobId ?? "?"} release=${exec.settle.releaseTx}`);

// 6. Verificación on-chain: release exitoso + evento del escrow + Transfer
// de USDC (la pata que le paga al forge — sin ella el release no vale).
const receipt = await rpc("eth_getTransactionReceipt", [exec.settle.releaseTx]);
if (!receipt || receipt.status !== "0x1") await die(`release revirtió o no existe: ${exec.settle.releaseTx}`);
const releasedLog = receipt.logs.find((l) => l.address.toLowerCase() === ESCROW.toLowerCase());
if (!releasedLog) await die("release sin evento del escrow");
const transfer = receipt.logs.find((l) => l.address.toLowerCase() === USDC.toLowerCase());
if (!transfer) await die("release sin Transfer de USDC");
console.log(`on-chain ✓ Released + Transfer USDC → ${transfer.topics[2].slice(-40)}`);

// 7. Reporte.
console.log(`
═══ LOOP VERIFICADO ON-CHAIN ═══
forge:     ${forge.forgePubkey} (agent ${forge.forgeAgentId ?? "—"})
fund:      ${EXPLORER}/tx/${exec.settle.fundTx}
release:   ${EXPLORER}/tx/${exec.settle.releaseTx}
escrow:    ${EXPLORER}/address/${ESCROW}
worker:    ${EXPLORER}/address/${forge.forgePubkey}
`);
for (const k of kids) k.kill("SIGTERM");
process.exit(0);
