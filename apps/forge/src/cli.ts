// weaver-forge — el daemon del operador (ADR-0005).
//   init      genera la identidad (keypair) + detecta modelos locales
//   up        conecta al gateway, reporta capacidad, ejecuta jobs
//   register  registra la pubkey on-chain (habilita cobro + renueva TTL)
// Uso: node src/cli.ts init [--gateway URL] [--instance id:model[:image]] ...
//      node src/cli.ts up [--config PATH] [--contract ID]
import { homedir } from "node:os";
import { join } from "node:path";
import { Address, Keypair, nativeToScVal } from "@stellar/stellar-sdk";
import { RpcSubmitter } from "@weaver/settlement";
import { FluxKleinForge, OllamaMLXAdapter, TrackedExec, TrackedImageExec } from "@weaver/forge-exec";
import { ForgeDaemon, type DaemonInstance } from "./daemon.ts";
import { initConfig, loadConfig, type ForgeConfig, type InstanceCfg } from "./config.ts";
import { connectLoop } from "./ws.ts";

const CONFIG_PATH = join(homedir(), ".weaver", "forge.json");

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const args = (flag: string): string[] => {
  const out: string[] = [];
  process.argv.forEach((a, i) => {
    if (a === flag && process.argv[i + 1]) out.push(process.argv[i + 1]);
  });
  return out;
};

// Auto-detect: los modelos instalados en Ollama local se ofrecen como
// instances de texto (cap 4 como el composition root embedded).
async function detectOllama(base = "http://localhost:11434"): Promise<InstanceCfg[]> {
  try {
    const r = await fetch(`${base}/api/tags`);
    const { models } = (await r.json()) as { models: { name: string; size?: number }[] };
    return models.map((m, i) => ({
      instanceId: `slot${i}-${m.name.replace(/[^a-z0-9]/gi, "-").slice(0, 20)}`,
      model: m.name,
      capability: "text",
      maxConcurrent: 4,
      loadTimeMs: 4000,
      // footprint ≈ tamaño en disco (aprox honesta — los weights son la mayoría
      // del VRAM en inferencia cuantizada; los budgets la usan como estimado).
      ...(m.size ? { vramGb: Math.ceil((m.size / 1e9) * 10) / 10 } : {}),
    }));
  } catch {
    return [];
  }
}

function makeInstances(cfg: ForgeConfig): DaemonInstance[] {
  return cfg.instances.map((c) => ({
    ...c,
    exec:
      c.capability === "image"
        ? new TrackedImageExec(new FluxKleinForge({ forgeId: c.instanceId, model: c.model }))
        : new TrackedExec(new OllamaMLXAdapter({ forgeId: c.instanceId, model: c.model, keepAlive: -1 })),
  }));
}

// S41/S42: sin register_forge on-chain el forge no es fondeable — el escrow
// rechaza el fund (ForgeNotFound). Re-registrar renueva el TTL de la key.
async function registerForge(cfg: ForgeConfig, contractId: string): Promise<string> {
  const kp = Keypair.fromSecret(cfg.secret);
  const rpc = arg("--rpc") ?? process.env.SOROBAN_RPC ?? "https://soroban-testnet.stellar.org";
  const submitter = new RpcSubmitter(rpc, cfg.secret);
  const invoke = () =>
    submitter.invoke(contractId, "register_forge", [
      new Address(cfg.pubkey).toScVal(),
      nativeToScVal(Buffer.from(kp.rawPublicKey())),
    ]);
  try {
    return (await invoke()).txHash;
  } catch (e) {
    // Cuenta sin fondear (testnet) → friendbot la crea y reintenta.
    if (!String(e).match(/not.found|no.account|404/i)) throw e;
    await fetch(`https://friendbot.stellar.org?addr=${cfg.pubkey}`);
    return (await invoke()).txHash;
  }
}

// S42 (I4): release como caller=worker — la misma fn para el comando `claim`
// manual y el seam `Claimer` del daemon (auto-claim ante job.funded).
function makeClaimer(cfg: ForgeConfig, contractId: string) {
  const rpc = arg("--rpc") ?? process.env.SOROBAN_RPC ?? "https://soroban-testnet.stellar.org";
  const submitter = new RpcSubmitter(rpc, cfg.secret);
  return async (chainJobId: number, resultHash: Buffer, forgeSig: Buffer): Promise<string> => {
    const { txHash } = await submitter.invoke(contractId, "release", [
      new Address(cfg.pubkey).toScVal(),
      nativeToScVal(chainJobId, { type: "u64" }),
      nativeToScVal(resultHash),
      nativeToScVal(forgeSig),
    ]);
    return txHash;
  };
}

const cmd = process.argv[2];
const cfgPath = arg("--config") ?? CONFIG_PATH;

if (cmd === "init") {
  const gateway = arg("--gateway") ?? "http://127.0.0.1:3001";
  let instances: InstanceCfg[] = args("--instance").map((s) => {
    const [instanceId, model, cap] = s.split(":");
    if (!instanceId || !model) throw new Error(`--instance inválido: ${s} (formato id:model[:image])`);
    return {
      instanceId,
      model: cap === "image" ? model : `${model}`,
      capability: cap === "image" ? "image" : "text",
      maxConcurrent: cap === "image" ? 1 : 4,
      loadTimeMs: cap === "image" ? 20000 : 4000,
    };
  });
  if (instances.length === 0) {
    instances = await detectOllama();
    if (instances.length === 0) {
      console.error("no detecté modelos Ollama y no pasaste --instance — nada que servir");
      process.exit(1);
    }
  }
  const budgets = {
    ...(process.argv.includes("--idle-only") ? { idleOnly: true } : {}),
    ...(arg("--max-vram-gb") ? { maxVramGb: Number(arg("--max-vram-gb")) } : {}),
  };
  const cfg = initConfig(cfgPath, {
    gateway,
    instances,
    ...(Object.keys(budgets).length ? { budgets } : {}),
  });
  console.log(`forge inicializado:
  pubkey (identidad + payout): ${cfg.pubkey}
  config: ${cfgPath} (0600 — el secreto no se muestra)
  instances: ${instances.map((i) => `${i.instanceId}→${i.model}(${i.capability})`).join(", ")}
siguiente paso: weaver-forge up`);
} else if (cmd === "claim") {
  // S42 (I4): self-claim — el forge cobra su propio job sin el operador.
  // Uso: weaver-forge claim --job N --hash HEX --sig HEX --contract ID
  const cfg = loadConfig(cfgPath);
  const contractId = arg("--contract") ?? process.env.SETTLEMENT_CONTRACT;
  const jobId = Number(arg("--job"));
  const hash = arg("--hash");
  const sig = arg("--sig");
  if (!contractId || !jobId || !hash || !sig) {
    console.error("claim necesita --contract ID --job N --hash HEX --sig HEX");
    process.exit(1);
  }
  const txHash = await makeClaimer(cfg, contractId)(jobId, Buffer.from(hash, "hex"), Buffer.from(sig, "hex"));
  console.log(`claim del job ${jobId} confirmado — tx ${txHash}`);
} else if (cmd === "register") {
  const cfg = loadConfig(cfgPath);
  const contractId = arg("--contract") ?? process.env.SETTLEMENT_CONTRACT;
  if (!contractId) {
    console.error("--contract o SETTLEMENT_CONTRACT requerido");
    process.exit(1);
  }
  const tx = await registerForge(cfg, contractId);
  console.log(`forge registrado on-chain — pubkey ${cfg.pubkey.slice(0, 16)}… tx ${tx}`);
} else if (cmd === "up") {
  const cfg = loadConfig(cfgPath);
  const kp = Keypair.fromSecret(cfg.secret);
  const instances = makeInstances(cfg);
  const sign = (hash: Buffer) => Buffer.from(kp.sign(hash));
  const contractId = arg("--contract") ?? process.env.SETTLEMENT_CONTRACT;
  if (contractId) {
    try {
      const tx = await registerForge(cfg, contractId);
      console.log(`register_forge ✓ tx ${tx} (renueva TTL 30d)`);
    } catch (e) {
      console.warn(`register_forge falló — el forge no será fondeable hasta registrar:`, e);
    }
  }
  console.log(`forge ${cfg.pubkey.slice(0, 16)}… levantando ${instances.length} instance(s):`);
  for (const i of instances) console.log(`  ${i.instanceId} → ${i.model} [${i.capability}] cap=${i.maxConcurrent}`);
  const loop = connectLoop(
    cfg,
    (channel) =>
      new ForgeDaemon({
        channel,
        instances,
        sign,
        ...(cfg.budgets ? { budgets: cfg.budgets } : {}),
        ...(contractId ? { claim: makeClaimer(cfg, contractId) } : {}),
      }),
  );
  process.on("SIGINT", () => {
    loop.cancel();
    process.exit(0);
  });
} else {
  console.log(`weaver-forge — daemon de forge remoto (ADR-0005)
  init      genera keypair + config (auto-detecta modelos Ollama)
  register  registra la pubkey en el contrato escrow (habilita cobro)
  claim     cobra un job fondeado sin el operador (--job --hash --sig)
  up        conecta al gateway y sirve jobs (--contract auto-registra)
flags: --config PATH --gateway URL --contract ID --rpc URL --instance id:model[:image]
       --idle-only        solo computar cuando la máquina está idle (>60s sin input)
       --max-vram-gb N    instances COLD solo se ofrecen si su carga entra en N GB`);
}
