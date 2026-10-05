// weaver-forge — el daemon del operador (ADR-0005).
//   init      genera la identidad (keypair) + detecta modelos locales
//   up        conecta al gateway, reporta capacidad, ejecuta jobs
//   register  registra la pubkey on-chain (habilita cobro + renueva TTL)
// Uso: node src/cli.ts init [--gateway URL] [--instance id:model[:image]] ...
//      node src/cli.ts up [--config PATH] [--contract ID]
import { homedir } from "node:os";
import { join } from "node:path";
import { Address, Keypair, nativeToScVal } from "@stellar/stellar-sdk";
import type { Address as EvmAddress, Hex } from "viem";
import {
  ESCROW_ABI,
  EvmSubmitter,
  evmForgeKeypair,
  forgeAgentURI,
  IDENTITY_ABI,
  ERC8004_IDENTITY,
  registerForgeEvm,
  RpcSubmitter,
} from "@weaver/settlement";
import { FluxKleinForge, OllamaMLXAdapter, OpenAICompatAdapter, TrackedExec, TrackedImageExec } from "@weaver/forge-exec";
import { ForgeDaemon, type DaemonInstance } from "./daemon.ts";
import { initConfig, loadConfig, saveConfig, type ForgeConfig, type InstanceCfg } from "./config.ts";
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

// Auto-detect OpenAI-compatible: /v1/models lista lo que el server tiene
// cargado (vLLM carga al boot — la lista ES la capacidad, honesta).
async function detectOpenAI(base: string, apiKey?: string): Promise<InstanceCfg[]> {
  try {
    const r = await fetch(`${base.replace(/\/$/, "")}/v1/models`, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    });
    const { data } = (await r.json()) as { data: { id: string }[] };
    return (data ?? []).map((m, i) => ({
      instanceId: `oai${i}-${m.id.replace(/[^a-z0-9]/gi, "-").slice(0, 20)}`,
      model: m.id,
      capability: "text",
      maxConcurrent: 8, // vLLM sirve batch real — cap mayor que Ollama local
      loadTimeMs: 0, // modelo ya residente en el server
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
        : c.backend?.type === "openai"
          ? new TrackedExec(
              new OpenAICompatAdapter({
                forgeId: c.instanceId,
                model: c.model,
                baseUrl: c.backend.baseUrl,
                ...(c.backend.apiKey ? { apiKey: c.backend.apiKey } : {}),
              }),
            )
          : new TrackedExec(new OllamaMLXAdapter({ forgeId: c.instanceId, model: c.model, keepAlive: -1 })),
  }));
}

// S41/S42: sin register_forge on-chain el forge no es fondeable — el escrow
// rechaza el fund (ForgeNotFound). Re-registrar renueva el TTL de la key.
// EVM (Monad): msg.sender = worker — el forge se registra a sí mismo con su
// propia key; el signer de proofs es su misma address (hot key única v1).
async function registerForge(cfg: ForgeConfig, contractId: string): Promise<string> {
  if (cfg.chain === "evm") {
    const sub = new EvmSubmitter({
      rpcUrl: arg("--rpc") ?? process.env.EVM_RPC_URL ?? "https://testnet-rpc.monad.xyz",
      privateKey: cfg.secret as Hex,
    });
    return registerForgeEvm(sub, contractId as EvmAddress, sub.address);
  }
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
// EVM: release(jobId, resultHash, forgeSig) — caller=worker (su propia key).
function makeClaimer(cfg: ForgeConfig, contractId: string) {
  if (cfg.chain === "evm") {
    const sub = new EvmSubmitter({
      rpcUrl: arg("--rpc") ?? process.env.EVM_RPC_URL ?? "https://testnet-rpc.monad.xyz",
      privateKey: cfg.secret as Hex,
    });
    return async (chainJobId: number, resultHash: Buffer, forgeSig: Buffer): Promise<string> => {
      const { txHash } = await sub.invoke(contractId as EvmAddress, ESCROW_ABI, "release", [
        BigInt(chainJobId),
        `0x${resultHash.toString("hex")}`,
        `0x${forgeSig.toString("hex")}`,
      ]);
      return txHash;
    };
  }
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

// ERC-8004 (EVM): el forge registra SU agente en el Identity Registry
// canónico — owner = su propia key (identidad portable, no de la plataforma).
// Registra con register() y luego setAgentURI (el register(uri) revierte con
// algunos formatos — dos txs explícitas, comprobado en testnet).
async function ensureAgentId(cfg: ForgeConfig, escrow?: string): Promise<number | undefined> {
  if (cfg.chain !== "evm" || cfg.agentId !== undefined) return cfg.agentId;
  const sub = new EvmSubmitter({
    rpcUrl: arg("--rpc") ?? process.env.EVM_RPC_URL ?? "https://testnet-rpc.monad.xyz",
    privateKey: cfg.secret as Hex,
  });
  const { retval } = await sub.invoke(ERC8004_IDENTITY, IDENTITY_ABI, "register", []);
  const agentId = Number(retval);
  const uri = forgeAgentURI({
    name: `weaver-forge-${cfg.pubkey.slice(0, 8)}`,
    model: cfg.instances[0]?.model ?? "unknown",
    worker: cfg.pubkey as EvmAddress,
    ...(escrow ? { escrow: escrow as EvmAddress } : {}),
  });
  await sub.invoke(ERC8004_IDENTITY, IDENTITY_ABI, "setAgentURI", [retval, uri]);
  return agentId;
}

const cmd = process.argv[2];
const cfgPath = arg("--config") ?? CONFIG_PATH;

if (cmd === "init") {
  const gateway = arg("--gateway") ?? "http://127.0.0.1:3001";
  let instances: InstanceCfg[] = args("--instance").map((s) => {
    // id:model[:image] — el modelo puede llevar ':' (tags Ollama: qwen3:4b).
    // Split en el primer ':' solamente; ":image" solo cuenta como sufijo.
    const idx = s.indexOf(":");
    const instanceId = idx > 0 ? s.slice(0, idx) : "";
    const rest = s.slice(idx + 1);
    const cap = rest.endsWith(":image") ? "image" : undefined;
    const model = cap ? rest.slice(0, -":image".length) : rest;
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
    // Con --openai-url el inventario honesto es /v1/models DE ESE server;
    // sin flag, auto-detect Ollama local como siempre.
    const oaiUrl = arg("--openai-url");
    instances = oaiUrl ? await detectOpenAI(oaiUrl, arg("--openai-key")) : await detectOllama();
    if (instances.length === 0) {
      console.error(
        oaiUrl
          ? `no detecté modelos en ${oaiUrl}/v1/models y no pasaste --instance — nada que servir`
          : "no detecté modelos Ollama y no pasaste --instance — nada que servir",
      );
      process.exit(1);
    }
  }
  const budgets = {
    ...(process.argv.includes("--idle-only") ? { idleOnly: true } : {}),
    ...(arg("--max-vram-gb") ? { maxVramGb: Number(arg("--max-vram-gb")) } : {}),
  };
  // --openai-url: todas las instances de texto hablan contra ese server
  // OpenAI-compatible (vLLM, llama.cpp-server, LM Studio). Modelos grandes
  // multi-GPU sin cambiar el protocolo — el forge es el front honesto.
  const openaiUrl = arg("--openai-url");
  if (openaiUrl) {
    for (const i of instances) {
      if (i.capability === "text") {
        i.backend = {
          type: "openai",
          baseUrl: openaiUrl,
          ...(arg("--openai-key") ? { apiKey: arg("--openai-key") } : {}),
        };
      }
    }
  }
  // --chain evm (Monad, ADR-0008) | stellar (default) — la chain la fija
  // init y el resto de los comandos la respetan desde el config.
  const chainArg = arg("--chain") ?? "stellar";
  if (chainArg !== "stellar" && chainArg !== "evm") {
    console.error(`--chain inválido: ${chainArg} (stellar|evm)`);
    process.exit(1);
  }
  const cfg = initConfig(cfgPath, {
    gateway,
    instances,
    chain: chainArg,
    ...(Object.keys(budgets).length ? { budgets } : {}),
  });
  console.log(`forge inicializado [${cfg.chain}]:
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
  // hex con o sin prefijo 0x (EVM lo emite así; Stellar no — strip neutro).
  const strip = (h: string) => Buffer.from(h.replace(/^0x/, ""), "hex");
  const txHash = await makeClaimer(cfg, contractId)(jobId, strip(hash), strip(sig));
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
  // --gateway sobreescribe el del config — el flag figuraba en usage pero
  // nunca se aplicaba (conectaba siempre al gateway del init).
  const gw = arg("--gateway");
  if (gw) cfg.gateway = gw;
  const instances = makeInstances(cfg);
  // Proof L0 por chain: ed25519 (stellar, sync) o personal_sign (evm, async).
  const sign: (hash: Buffer) => Buffer | Promise<Buffer> =
    cfg.chain === "evm"
      ? evmForgeKeypair(cfg.secret as Hex).sign
      : ((hash) => Buffer.from(Keypair.fromSecret(cfg.secret).sign(hash)));
  const contractId = arg("--contract") ?? process.env.SETTLEMENT_CONTRACT;
  if (contractId) {
    try {
      const tx = await registerForge(cfg, contractId);
      console.log(`register_forge ✓ tx ${tx}${cfg.chain === "evm" ? "" : " (renueva TTL 30d)"}`);
    } catch (e) {
      console.warn(`register_forge falló — el forge no será fondeable hasta registrar:`, e);
    }
  }
  // ERC-8004 (EVM): identidad portable del forge — register + setAgentURI en
  // el primer boot; el agentId queda en config para los próximos.
  if (cfg.chain === "evm" && cfg.agentId === undefined) {
    try {
      const agentId = await ensureAgentId(cfg, contractId);
      if (agentId !== undefined) {
        cfg.agentId = agentId;
        saveConfig(cfgPath, cfg);
        console.log(`erc-8004 agent registrado — agentId ${agentId} (owner ${cfg.pubkey.slice(0, 10)}…)`);
      }
    } catch (e) {
      console.warn("erc-8004 register falló (sin gas/URI inválida) — sigo sin identidad on-chain:", e);
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
        ...(cfg.agentId !== undefined ? { agentId: cfg.agentId } : {}),
        ...(contractId ? { claim: makeClaimer(cfg, contractId) } : {}),
      }),
  );
  process.on("SIGINT", () => {
    loop.cancel();
    process.exit(0);
  });
} else {
  console.log(`weaver-forge — daemon de forge remoto (ADR-0005)
  init      genera keypair + config (auto-detecta modelos Ollama) [--chain stellar|evm]
  register  registra la pubkey en el contrato escrow (habilita cobro)
  claim     cobra un job fondeado sin el operador (--job --hash --sig)
  up        conecta al gateway y sirve jobs (--contract auto-registra)
flags: --config PATH --gateway URL --contract ID --rpc URL --instance id:model[:image]
       --chain stellar|evm  solo en init — el resto lee la chain del config
       --openai-url URL   backend OpenAI-compatible para text (vLLM/llama.cpp-server)
       --openai-key KEY   bearer opcional para ese backend
       --idle-only        solo computar cuando la máquina está idle (>60s sin input)
       --max-vram-gb N    instances COLD solo se ofrecen si su carga entra en N GB`);
}
