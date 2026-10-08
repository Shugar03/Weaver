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
import { killAllRpcProcs, makePooledFactory, probeTcp, spawnRpcServer, type RpcProc } from "./rpcproc.ts";
import { startStageServer, type StageServer } from "./stageserver.ts";
import { simStageCompute, PipelineExec, simFront } from "./pipeline.ts";
import { tcpStageDial } from "./stagetransport.ts";

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

function makeInstances(
  cfg: ForgeConfig,
  procs: Map<string, RpcProc>,
  stageServers: Map<string, StageServer>,
): DaemonInstance[] {
  return cfg.instances.map((c) => {
    // rpc-worker: sin exec — presta VRAM. Su salud ES el ggml-rpc-server que
    // up spawneó (o el alive:false honesto si el binario no estaba).
    if (c.capability === "rpc-worker") {
      const proc = procs.get(c.instanceId) ?? { alive: false, kill() {} };
      // live = proc vivo Y endpoint alcanzable (self-probe TCP — el socket
      // puede morir aunque el proceso respire).
      return { ...c, rpcProc: proc, rpcProbe: () => probeTcp(c.rpc!.endpoint) };
    }
    // stage-worker: sin exec — presta BLOQUES del modelo. Su salud ES el
    // stage-server TCP spawneado en up + self-probe del endpoint.
    if (c.capability === "stage-worker") {
      const srv = stageServers.get(c.instanceId);
      return {
        ...c,
        stageServer: {
          get alive() {
            return srv?.alive === true;
          },
          get sessions() {
            return srv?.sessions() ?? 0;
          },
        },
        stageProbe: () => probeTcp(c.stage!.endpoint),
      };
    }
    return {
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
    };
  });
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
    if (instances.length === 0 && args("--rpc-worker").length === 0) {
      console.error(
        oaiUrl
          ? `no detecté modelos en ${oaiUrl}/v1/models y no pasaste --instance — nada que servir`
          : "no detecté modelos Ollama y no pasaste --instance ni --rpc-worker — nada que servir",
      );
      process.exit(1);
    }
  }
  // S46 (spec 017): --rpc-worker id:host:port — instance que SOLO presta VRAM
  // vía ggml-rpc-server (up lo spawnea). NO rutea jobs normales: es recurso
  // del pool. id puede ser cualquier string sin ':'; el endpoint lo valida
  // el codec del heartbeat (IPv4/host/[IPv6]:port).
  for (const w of args("--rpc-worker")) {
    const idx = w.indexOf(":");
    const instanceId = idx > 0 ? w.slice(0, idx) : "";
    const endpoint = w.slice(idx + 1);
    if (!instanceId || !endpoint) {
      console.error(`--rpc-worker inválido: ${w} (formato id:host:port)`);
      process.exit(1);
    }
    const vram = arg("--rpc-vram");
    instances.push({
      instanceId,
      model: "rpc",
      capability: "rpc-worker",
      maxConcurrent: 1,
      loadTimeMs: 0,
      rpc: { endpoint, ...(vram ? { vramGb: Number(vram) } : {}) },
    });
  }
  // --pool N[:MINVRAM]: las instances de texto se anuncian como coordinator
  // pooled — "sirvo este modelo si el gateway me presta N rpc-workers de ≥
  // MINVRAM GB". Necesitan --model-file: el llama-server clustered spawnea
  // de un GGUF local. maxConcurrent se clampa a 1: cada job pooled usa un
  // llama-server del peso del modelo — >1 = varios servers = OOM del host.
  const poolParts = (arg("--pool") ?? "").split(":");
  const poolN = Number(poolParts[0]);
  const poolMinVram = poolParts[1] !== undefined ? Number(poolParts[1]) : undefined;
  if (poolN > 0) {
    for (const i of instances) {
      if (i.capability !== "text") continue;
      i.pool = { needs: Math.trunc(poolN), ...(poolMinVram ? { minVramGb: poolMinVram } : {}) };
      if (i.maxConcurrent > 1) {
        console.warn(`--pool: ${i.instanceId} maxConcurrent ${i.maxConcurrent}→1 (un llama-server por job)`);
        i.maxConcurrent = 1;
      }
    }
    if (!arg("--model-file")) {
      console.warn("--pool sin --model-file: el coordinator no podrá spawnear llama-server (job.assign fallará)");
    }
  }
  const modelFile = arg("--model-file");
  if (modelFile) {
    for (const i of instances) {
      if (i.capability === "text") i.modelFile = modelFile;
    }
  }
  // S47 (spec 018): --stage-worker id:k-n:host:port — instance que SOLO
  // presta bloques del modelo vía stage-server TCP (up lo levanta). NO rutea
  // jobs: es recurso del StagePool. --stage-model fija el modelo (compartido
  // con el coordinator — el pool solo parkea mismo modelo).
  //   ej: --stage-worker s1:0-40:10.0.0.5:50100 --stage-model qwen-235b
  const stageModel = arg("--stage-model");
  for (const w of args("--stage-worker")) {
    const m = /^([^:]+):(\d+)-(\d+):(.+)$/.exec(w);
    if (!m || !stageModel) {
      console.error(`--stage-worker inválido: ${w} (formato id:k-n:host:port, requiere --stage-model)`);
      process.exit(1);
    }
    instances.push({
      instanceId: m[1],
      model: stageModel,
      capability: "stage-worker",
      maxConcurrent: 1, // una sesión: el KV de dos jobs no comparte GPU
      loadTimeMs: 0,
      stage: { layers: [Number(m[2]), Number(m[3])], endpoint: m[4] },
    });
  }
  // --pipeline BLOCKS: las instances text se anuncian como coordinator
  // federado — "sirvo este modelo si me armás la cadena de stages". No hay
  // modelo local completo: assign sin stages = fail honesto.
  const pipelineBlocks = Number(arg("--pipeline"));
  if (pipelineBlocks > 0) {
    for (const i of instances) {
      if (i.capability !== "text") continue;
      i.pipeline = { blocks: Math.trunc(pipelineBlocks) };
      if (i.maxConcurrent > 1) {
        console.warn(`--pipeline: ${i.instanceId} maxConcurrent ${i.maxConcurrent}→1 (una cadena por job)`);
        i.maxConcurrent = 1;
      }
    }
    console.warn("--pipeline: substrate = stage-sim (activaciones reales por TCP, cómputo simulado — block-runner real es fase B)");
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
  // --rpc-allow p1,p2: allowlist de hosts que el daemon acepta como rpcPeers
  // (prefijo o host exacto — ej "192.168." o "gpu1.lan"). El assign viene del
  // gateway; el operador decide a quién diala su llama-server.
  const rpcAllow = arg("--rpc-allow")?.split(",").map((s) => s.trim()).filter(Boolean);
  const cfg = initConfig(cfgPath, {
    gateway,
    instances,
    chain: chainArg,
    ...(Object.keys(budgets).length ? { budgets } : {}),
    ...(rpcAllow?.length ? { rpcAllow } : {}),
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
  // S46 worker: spawn de ggml-rpc-server por instance rpc-worker ANTES de
  // conectar — el primer heartbeat ya reporta alive real. Si el binario
  // falta reporto muerto (alive:false) — honesto, no crasheo el forge.
  const procs = new Map<string, RpcProc>();
  const rpcBin = arg("--rpc-bin") ?? process.env.RPC_SERVER_BIN ?? "ggml-rpc-server";
  for (const c of cfg.instances) {
    if (c.capability !== "rpc-worker" || !c.rpc?.endpoint) continue;
    try {
      procs.set(c.instanceId, spawnRpcServer(rpcBin, c.rpc.endpoint));
      console.log(`ggml-rpc-server ${c.instanceId} → ${c.rpc.endpoint}`);
    } catch (e) {
      console.warn(`rpc-server ${c.instanceId} no spawneó — heartbeateo muerto:`, e);
    }
  }
  // Proof L0 por chain: ed25519 (stellar, sync) o personal_sign (evm, async).
  // Arriba del stage-server: el compute firma su cadena con ESTA misma key —
  // la atribución de tramo queda ligada a la identidad del forge (A4).
  const sign: (hash: Buffer) => Buffer | Promise<Buffer> =
    cfg.chain === "evm"
      ? evmForgeKeypair(cfg.secret as Hex).sign
      : ((hash) => Buffer.from(Keypair.fromSecret(cfg.secret).sign(hash)));
  // S47 worker: stage-server TCP por instance stage-worker — bindea el
  // endpoint declarado ANTES de conectar (el primer heartbeat ya reporta
  // alive real). Substrate sim por ahora — el wire es el de prod.
  const stageServers = new Map<string, StageServer>();
  for (const c of cfg.instances) {
    if (c.capability !== "stage-worker" || !c.stage?.endpoint) continue;
    const m = /^(.+):(\d+)$/.exec(c.stage.endpoint);
    if (!m) {
      console.warn(`stage-worker ${c.instanceId}: endpoint inválido ${c.stage.endpoint} — reporto muerto`);
      continue;
    }
    try {
      const srv = startStageServer({
        host: m[1].replace(/^\[|\]$/g, ""),
        port: Number(m[2]),
        compute: simStageCompute(c.stage.layers, c.instanceId.replace(/\W/g, ""), async (h) => (await sign(h)).toString("hex")),
      });
      await srv.ready;
      stageServers.set(c.instanceId, srv);
      console.log(`stage-server ${c.instanceId} [${c.stage.layers}] → ${c.stage.endpoint} (substrate: sim)`);
    } catch (e) {
      console.warn(`stage-server ${c.instanceId} no bindeó — heartbeateo muerto:`, e);
    }
  }
  const instances = makeInstances(cfg, procs, stageServers);
  // S46 coordinator: alguna instance pide workers → factory que spawnea
  // llama-server --rpc peers por peer-set (warm-keyed, ver rpcproc.ts).
  const pooledFactory = cfg.instances.some((i) => i.capability === "text" && i.pool?.needs)
    ? makePooledFactory({ llamaBin: arg("--llama-bin") ?? process.env.LLAMA_SERVER_BIN ?? "llama-server" })
    : undefined;
  // S47 coordinator: alguna instance declaró pipeline → PipelineExec con
  // transport TCP real. Front = sim (fase B: embeddings+lmhead de verdad).
  const pipelineFactory = cfg.instances.some((i) => i.pipeline)
    ? (inst: DaemonInstance, stages: { endpoint: string; blocks: [number, number] }[], _signal?: AbortSignal, requestStage?: (dead: string, blocks: [number, number]) => Promise<{ endpoint?: string; blocks?: [number, number] }>) =>
        Promise.resolve(
          new PipelineExec({
            forgeId: inst.instanceId,
            model: inst.model,
            stages,
            dial: tcpStageDial,
            front: simFront(),
            ...(requestStage ? { requestStage } : {}),
          }),
        )
    : undefined;
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
        ...(pooledFactory ? { pooledFactory } : {}),
        ...(pipelineFactory ? { pipelineFactory } : {}),
        // Allowlist operador de rpcPeers — el gateway propone, el forge
        // dispone: solo diala hosts que el operador declaró en init.
        ...(cfg.rpcAllow?.length
          ? {
              allowRpcPeers: (peers: string[]) =>
                peers.every((p) => {
                  const host = p.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
                  return cfg.rpcAllow!.some((a) => host === a || host.startsWith(a));
                }),
            }
          : {}),
      }),
  );
  process.on("SIGINT", () => {
    killAllRpcProcs(); // llama-server/ggml-rpc-server hijos mueren con el daemon
    for (const s of stageServers.values()) s.close(); // stage-servers mueren también
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
       --max-vram-gb N    instances COLD solo se ofrecen si su carga entra en N GB
       --rpc-worker id:host:port  S46: instance que solo presta VRAM (ggml-rpc-server)
       --rpc-vram N       VRAM GB anunciada por los rpc-worker
       --pool N[:MINVRAM] S46: las instances text piden N workers prestados (coordinator)
       --model-file PATH  GGUF local para el llama-server pooled
       --rpc-allow p1,p2  allowlist de hosts aceptados como rpcPeers (prefijo/exacto)
       --rpc-bin BIN      binario rpc-server (default ggml-rpc-server, env RPC_SERVER_BIN)
       --stage-worker id:k-n:host:port  S47: instance que presta bloques k..n (stage-server TCP)
       --stage-model M    modelo de los stage-worker (compartido con el coordinator)
       --pipeline BLOCKS  S47: las instances text coordinan por stages (substrate sim)
       --llama-bin BIN    binario llama-server (default llama-server, env LLAMA_SERVER_BIN)`);
}
