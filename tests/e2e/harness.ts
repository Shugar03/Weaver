// Harness compartido para e2e de wire real: gateway completo (Hono app +
// attachForgeWS) + daemons conectados por connect() (challenge REST → auth
// ed25519 → heartbeat). Lo único scripteado es el engine local de cada daemon.
import { serve } from "@hono/node-server";
import { createApp } from "@weaver/gateway";
import { attachForgeWS, type ForgeWS } from "@weaver/gateway/forgews";
import { ForgeRegistry, NonceStore } from "@weaver/forge-net";
import { RoutedExec } from "@weaver/forge-exec";
import { dualVerify, stellarKeypair } from "@weaver/settlement";
import type { ExecRequest, ForgeExec, ImageExec } from "@weaver/forge-exec";
import type { ForgeView } from "@weaver/scheduler";
import {
  ForgeDaemon,
  connect,
  PipelineExec,
  probeTcp,
  simFront,
  simStageCompute,
  startStageServer,
  tcpStageDial,
  type DaemonInstance,
  type ForgeConfig,
  type PipelineFactory,
  type PipelineFront,
  type StageServer,
} from "@weaver/forge";
import { spawn, type ChildProcess } from "node:child_process";

export type Stack = {
  url: string;
  registry: ForgeRegistry;
  fws: ForgeWS;
  close(): void;
};

// Orden por instanceId — determinístico, no depende de ping/ETR medido.
export function startStack(): Promise<Stack> {
  const registry = new ForgeRegistry();
  const nonces = new NonceStore();
  const box: { fws?: ForgeWS } = {};
  const liveExecs = new Proxy({} as Record<string, ForgeExec>, {
    get: (_t, k) => box.fws?.remoteExecs.get(k as string),
  });
  const liveImageExecs = new Proxy({} as Record<string, ImageExec>, {
    get: (_t, k) => box.fws?.remoteImageExecs.get(k as string),
  });
  const exec = new RoutedExec({
    forges: async () =>
      registry.views().filter((v: ForgeView) => (v.capability ?? "text") === "text" && v.attested !== false),
    execs: liveExecs,
    order: (_req: ExecRequest, views: ForgeView[]) => [...views].sort((a, b) => a.forgeId.localeCompare(b.forgeId)),
  });
  const app = createApp({
    forges: async () => registry.views(),
    exec,
    imageExecs: liveImageExecs,
    media: new Map(),
    forgePubkeyOf: (id) => registry.pubkeyOf(id),
    challenges: nonces,
    verifyProof: dualVerify,
  });
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  const fws = attachForgeWS(server as never, {
    registry,
    nonces,
    verify: dualVerify,
    // Los workers del e2e anuncian IPs fake (10.99.x.x) — el probe TCP real
    // los rechazaría. La cobertura del probe vive en pool.test.ts; acá lo
    // que se prueba es el wire completo gateway↔daemons.
    poolProbe: async () => true,
    // Retry de attestation cada 400ms (prod 30s) — el e2e del coordinator-
    // sin-workers necesita ver el reintento sin esperar medio minuto.
    attestRetryMs: 400,
  });
  box.fws = fws;
  return new Promise((res) =>
    setTimeout(
      () =>
        res({
          url: `http://127.0.0.1:${(server as unknown as { address(): { port: number } }).address().port}`,
          registry,
          fws,
          close() {
            fws.stop();
            const srv = server as unknown as { close(): void; closeIdleConnections?(): void };
            srv.close();
            // Keep-alive: fetch() deja los sockets idle en el pool — sin esto
            // el server-side socket queda abierto y el proceso no termina.
            srv.closeIdleConnections?.();
          },
        }),
      50,
    ),
  );
}

type Kp = { pubkey: string; secret: string; sign(m: Buffer): Buffer };

async function spawnDaemon(
  stack: Stack,
  instances: DaemonInstance[],
  kp: Kp,
  pooledFactory?: ConstructorParameters<typeof ForgeDaemon>[0]["pooledFactory"],
  pipelineFactory?: PipelineFactory,
  stageSecret?: string,
): Promise<{ daemon: ForgeDaemon; kp: Kp }> {
  const channel = await connect({
    gateway: stack.url, chain: "stellar", pubkey: kp.pubkey, secret: kp.secret, instances: [],
  } as ForgeConfig);
  const d = new ForgeDaemon({
    channel,
    instances,
    sign: kp.sign,
    // 550ms > HB_MIN_MS(500) del session rate-limiter — a 60ms el daemon
    // comía flood-violations y la sesión moría por "heartbeat flood" ~300ms
    // después de conectar. El primer beat va inmediato igual.
    heartbeatMs: 550,
    probes: { idleMs: async () => null, vramUsedGb: async () => null },
    ...(pooledFactory ? { pooledFactory } : {}),
    ...(pipelineFactory ? { pipelineFactory } : {}),
    ...(stageSecret ? { stageSecret } : {}),
  });
  d.start();
  return { daemon: d, kp };
}

// Daemon real por el wire: connect() hace challenge+auth contra el stack,
// ForgeDaemon corre el protocolo. Devuelve el keypair — el kill/reconnect
// necesita la MISMA pubkey.
export function upDaemon(
  stack: Stack,
  instanceId: string,
  engine: ForgeExec,
  kp: Kp = stellarKeypair(),
): Promise<{ daemon: ForgeDaemon; kp: Kp }> {
  return spawnDaemon(
    stack,
    [{ instanceId, model: "qwen3.5:4b", capability: "text", exec: engine, maxConcurrent: 4, loadTimeMs: 0 }],
    kp,
  );
}

export function upImageDaemon(
  stack: Stack,
  instanceId: string,
  engine: ImageExec,
  kp: Kp = stellarKeypair(),
): Promise<{ daemon: ForgeDaemon; kp: Kp }> {
  return spawnDaemon(
    stack,
    [{ instanceId, model: "flux2-klein-4b", capability: "image", exec: engine, maxConcurrent: 4, loadTimeMs: 0 }],
    kp,
  );
}

// S46 pool-forge: daemon que SOLO presta VRAM — sin exec, anuncia su endpoint
// rpc por heartbeat (prod: ggml-rpc-server real; acá el proc es un flag).
export function upRpcDaemon(
  stack: Stack,
  instanceId: string,
  endpoint: string,
  proc: { alive: boolean },
  kp: Kp = stellarKeypair(),
): Promise<{ daemon: ForgeDaemon; kp: Kp }> {
  return spawnDaemon(
    stack,
    [{ instanceId, model: "rpc", capability: "rpc-worker", rpc: { endpoint, vramGb: 24 }, rpcProc: proc, maxConcurrent: 1, loadTimeMs: 0 }],
    kp,
  );
}

// Daemon coordinator pooled: anuncia pool.needs y resuelve el exec vía
// pooledFactory cuando el assign trae rpcPeers (prod: llama-server --rpc).
// `onPeers` deja espiar los endpoints que llegaron por el wire.
export function upPooledDaemon(
  stack: Stack,
  instanceId: string,
  engine: ForgeExec,
  needs: number,
  kp: Kp = stellarKeypair(),
  onPeers?: (peers: string[]) => ForgeExec,
): Promise<{ daemon: ForgeDaemon; kp: Kp }> {
  return spawnDaemon(
    stack,
    [{ instanceId, model: "qwen3.5:4b", capability: "text", exec: engine, maxConcurrent: 4, loadTimeMs: 0, pool: { needs } }],
    kp,
    // e2e: el exec pooled ES el engine scripteado — prod sería un adapter al
    // llama-server spawneado con --rpc peers.
    (_inst, peers) => Promise.resolve(onPeers ? onPeers(peers) : engine),
  );
}

// S47 stage-federation: daemon que presta BLOQUES del modelo — un
// stage-server TCP REAL (loopback, no fake) corriendo simStageCompute.
// El transport es el de prod (tcpStageDial lo diala); solo el cómputo es sim.
export async function upStageDaemon(
  stack: Stack,
  instanceId: string,
  layers: [number, number],
  model = "qwen3.5:4b",
  kp: Kp = stellarKeypair(),
  opts: { stepDelayMs?: number; stageSecret?: string | null } = {},
): Promise<{
  daemon: ForgeDaemon;
  kp: Kp;
  server: StageServer;
  endpoint: string;
  compute: ReturnType<typeof simStageCompute>;
}> {
  // sign con la keypair del forge (misma que en job.done) — el close-ack
  // lleva la firma del tramo y el gateway la verifica contra el loan (A4).
  // stageSecret (B1): el compute exige capability en open y el daemon la
  // mintea ante stage.grant — mismo secret en ambos lados. DEFAULT en el
  // harness: auth siempre activa (un stage WAN sin auth es un agujero — el
  // e2e corre siempre en la postura segura; null explícito = modo sin-auth).
  const secret = opts.stageSecret === null ? undefined : (opts.stageSecret ?? "e2e-stage-secret");
  // Tag por TRAMO, no por instancia: dos forges corriendo el mismo rango de
  // bloques producen outputs idénticos (como el substrate real — misma
  // entrada → mismo tensor). El boundary-check del gateway depende de eso:
  // un reemplazo debe converger al outChain del tramo que cubre.
  const inner = simStageCompute(layers, `s${layers[0]}`, async (h) => kp.sign(h).toString("hex"), secret);
  const compute = inner as ReturnType<typeof simStageCompute>;
  if (opts.stepDelayMs) {
    // stepDelayMs: pasos más lentos → la ventana mid-job existe para matarlo
    // (un job de 6 tokens sin delay termina antes de poder romper nada).
    const orig = inner.step;
    const delay = opts.stepDelayMs;
    compute.step = ((s: Parameters<typeof inner.step>[0]) => sleep(delay).then(() => orig(s))) as unknown as typeof compute.step;
  }
  const server = startStageServer({ host: "127.0.0.1", port: 0, compute });
  await server.ready;
  const endpoint = `127.0.0.1:${server.port}`;
  const { daemon, kp: k } = await spawnDaemon(
    stack,
    [
      {
        instanceId,
        model,
        capability: "stage-worker",
        stage: { layers, endpoint },
        stageServer: {
          get alive() {
            return server.alive;
          },
          get sessions() {
            return server.sessions();
          },
        },
        stageProbe: () => probeTcp(endpoint),
        maxConcurrent: 1,
        loadTimeMs: 0,
      },
    ],
    kp,
    undefined,
    undefined,
    secret,
  );
  return { daemon, kp: k, server, endpoint, compute };
}

// Coordinator federado: declara pipeline.blocks y resuelve el exec con un
// PipelineExec REAL — tcpStageDial contra los endpoints del assign, front
// inyectable (simFront por default; httpFront contra un edge-runner real en
// fase C), requestStage cableado por el daemon (stage.need → stage.offer).
export function upPipelineDaemon(
  stack: Stack,
  instanceId: string,
  blocks: number,
  model = "qwen3.5:4b",
  kp: Kp = stellarKeypair(),
  front?: PipelineFront,
  // B2: "direct" = data plane stage→stage (fwd/replay/repoint); relay default.
  mode: "relay" | "direct" = "relay",
): Promise<{ daemon: ForgeDaemon; kp: Kp }> {
  return spawnDaemon(
    stack,
    [
      {
        instanceId,
        model,
        capability: "text",
        pipeline: { blocks },
        maxConcurrent: 1,
        loadTimeMs: 0,
      },
    ],
    kp,
    undefined,
    (inst, stages, _signal, requestStage) =>
      Promise.resolve(
        new PipelineExec({
          forgeId: inst.instanceId,
          model: inst.model,
          stages,
          dial: tcpStageDial,
          front: front ?? simFront(),
          coordPubkey: kp.pubkey, // B1: el token del assign ata a ESTA identidad
          ...(requestStage ? { requestStage } : {}),
          mode,
        }),
      ),
  );
}

// Fase C: stage-worker REAL — el stage-server es el proceso python
// (tools/stage_runner.py, pesos HF + KV por sesión); el daemon solo
// heartbeat + probe (--stage-ext equivalente). Firma: el runner deriva
// ed25519 del seed Stellar del kp → forgePubkey idéntico → verif real.
export function upPyStageDaemon(
  stack: Stack,
  instanceId: string,
  layers: [number, number],
  model: string,
  kp: Kp = stellarKeypair(),
  stageSecret?: string | null,
): Promise<{ daemon: ForgeDaemon; kp: Kp; endpoint: string; proc: ChildProcess }> {
  return (async () => {
    const port = 52000 + Math.floor(Math.random() * 5000);
    const endpoint = `127.0.0.1:${port}`;
    // B1 default igual que upStageDaemon: auth siempre activa en e2e —
    // null explícito = modo sin-auth (tests de compat).
    const secret = stageSecret === null ? undefined : (stageSecret ?? "e2e-stage-secret");
    const proc = spawn("python3", [
      "tools/stage_runner.py", "--role", "stage", "--model", model,
      "--blocks", String(layers[0]), String(layers[1]),
      "--port", String(port), "--tag", instanceId.replace(/\W/g, ""),
      "--sign-seed", kp.secret,
      // B1: el runner verifica la capability con el MISMO secret que el
      // daemon usa para mintearla (env WEAVER_STAGE_SECRET en prod).
      ...(secret ? ["--stage-secret", secret] : []),
    ], { stdio: ["ignore", "pipe", "inherit"] });
    const ready = new Promise<void>((res, rej) => {
      const to = setTimeout(() => rej(new Error(`stage_runner ${instanceId} no levantó en 180s`)), 180_000);
      proc.stdout!.on("data", (d: Buffer) => {
        if (d.toString().includes("listo")) { clearTimeout(to); res(); }
      });
    });
    await ready;
    const { daemon, kp: k } = await spawnDaemon(
      stack,
      [{
        instanceId, model, capability: "stage-worker",
        stage: { layers, endpoint },
        stageServer: { alive: true, sessions: 0 }, // externo — el probe decide
        stageProbe: () => probeTcp(endpoint),
        maxConcurrent: 1, loadTimeMs: 0,
      }],
      kp,
      undefined,
      undefined,
      secret,
    );
    return { daemon, kp: k, endpoint, proc };
  })();
}

// Edge-runner real (embed + norm + lm_head + tokenizer del checkpoint) —
// la mitad local del coordinator en fase C. Devuelve la URL del servicio.
export function upEdge(model: string): Promise<{ url: string; proc: ChildProcess }> {
  return (async () => {
    const port = 53000 + Math.floor(Math.random() * 5000);
    const proc = spawn("python3", [
      "tools/stage_runner.py", "--role", "edge", "--model", model, "--port", String(port),
    ], { stdio: ["ignore", "pipe", "inherit"] });
    const ready = new Promise<void>((res, rej) => {
      const to = setTimeout(() => rej(new Error("edge no levantó en 180s")), 180_000);
      proc.stdout!.on("data", (d: Buffer) => {
        if (d.toString().includes("edge listo")) { clearTimeout(to); res(); }
      });
    });
    await ready;
    return { url: `http://127.0.0.1:${port}`, proc };
  })();
}

// Los jobs attest-* los dispara el gateway al registrar la instance —
// los engines scripteados los sirven siempre para pasar la attestation real.
export const isAttest = (req: { jobId: string }): boolean => req.jobId.startsWith("attest-");

export const untilAttested = async (registry: ForgeRegistry, n: number, ms = 8000): Promise<void> => {
  const t0 = Date.now();
  while (registry.views().filter((v: ForgeView) => v.attested === true).length < n && Date.now() - t0 < ms) {
    await new Promise((r) => setTimeout(r, 50));
  }
};

// La instance sale de views — post-drop el forge deja de ser ruteable.
export const untilGone = async (registry: ForgeRegistry, forgeId: string, ms = 4000): Promise<void> => {
  const t0 = Date.now();
  while (registry.views().some((v) => v.forgeId === forgeId) && Date.now() - t0 < ms) {
    await new Promise((r) => setTimeout(r, 50));
  }
};

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// PNG real y decodable (no un header vacío): IHDR + IDAT con deflate de
// pixeles random — incompressible a propósito, así el b64 supera el floor
// de attestImage (b64.length > 1000) sin inflar el string a mano.
import { deflateSync } from "node:zlib";
import { randomFillSync } from "node:crypto";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

export function noisyPng(w = 64, h = 64): string {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) randomFillSync(raw, y * (1 + w * 3) + 1, w * 3);
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  return png.toString("base64");
}

export function chatRequest(url: string, prompt = "hola"): Promise<Response> {
  return fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "qwen3.5:4b", messages: [{ role: "user", content: prompt }], stream: true }),
  });
}

export async function chatStream(url: string): Promise<string> {
  const res = await chatRequest(url);
  return res.text();
}

// Lee el SSE hasta que el acumulado contenga `needle` — sincroniza contra lo
// que el CLIENTE ya recibió (no contra lo que el engine emitió localmente).
// Timeout explícito: un stream que no termina debe fallar el test, no colgarlo.
export async function readUntil(res: Response, acc: string, needle: string, ms = 10_000): Promise<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const deadline = Date.now() + ms;
  while (!acc.includes(needle)) {
    const { done, value } = await Promise.race([
      reader.read(),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error(`readUntil timeout esperando ${JSON.stringify(needle)} — recibido: ${acc.slice(-200)}`)), Math.max(1, deadline - Date.now())),
      ),
    ]);
    if (done) break;
    acc += dec.decode(value, { stream: true });
  }
  reader.releaseLock();
  return acc;
}
