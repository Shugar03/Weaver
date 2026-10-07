// S46 — ciclo de vida de los procesos llama.cpp RPC (spec 017, A2/A3 prod).
//
// Worker (rpc-worker): `ggml-rpc-server -h HOST -p PORT` — presta VRAM por
//   red, el daemon solo reporta su salud (rpcProc.alive → live).
// Coordinator (pool.needs): `llama-server -m MODEL --rpc peers…
//   --split-mode layer -p PORT` spawneado on-demand por peer-set; la factory
//   devuelve un OpenAICompatAdapter contra él. Warm-keyed: mismo conjunto de
//   peers = mismo server residente (no recargamos 400B por job).
//
// SEGURIDAD: endpoints host:port crudos = SOLO LAN/red privada (ADR-0010).
// ggml-rpc-server no tiene auth — sobre WAN abierto esto es superficie de
// ejecución remota. El spec 017 deja el túnel autenticado para Fase B.
import { spawn, type ChildProcess } from "node:child_process";
import { OpenAICompatAdapter, type ForgeExec } from "@weaver/forge-exec";
import type { DaemonInstance } from "./daemon.ts";

// Handle mínimo que el daemon consume en heartbeat: alive = el proceso vive.
export type RpcProc = { alive: boolean; kill(): void };

const children = new Set<ChildProcess>();
let hookArmed = false;

// Mata todos los hijos al salir — SIGINT llega por el handler del cli, exit
// cubre throws/exit() limpios. SIGKILL: un llama-server con 100B+ en VRAM no
// siempre sale amable y dejarlo zombie es peor.
function armExitHook(): void {
  if (hookArmed) return;
  hookArmed = true;
  const killAll = () => {
    for (const p of children) {
      try { if (!p.killed) p.kill("SIGKILL"); } catch { /* ya murió */ }
    }
  };
  process.on("exit", killAll);
  process.on("SIGTERM", () => { killAll(); process.exit(143); });
}

export function killAllRpcProcs(): void {
  for (const p of children) {
    try { if (!p.killed) p.kill("SIGKILL"); } catch { /* ya murió */ }
  }
  children.clear();
}

function track(child: ChildProcess): RpcProc {
  armExitHook();
  children.add(child);
  const proc: RpcProc = {
    alive: true,
    kill() {
      try { if (!child.killed) child.kill("SIGKILL"); } catch { /* ya murió */ }
      children.delete(child);
      proc.alive = false;
    },
  };
  child.on("exit", () => {
    proc.alive = false;
    children.delete(child);
  });
  return proc;
}

// Worker: spawnea ggml-rpc-server bindeado al host del endpoint anunciado.
// El endpoint ES lo que el coordinator va a dialar — bindear otra iface sería
// mentir en el heartbeat (live:true contra un puerto que no escucha).
export function spawnRpcServer(
  bin: string,
  endpoint: string,
): RpcProc {
  const m = /^(.+):(\d+)$/.exec(endpoint);
  if (!m) throw new Error(`endpoint inválido: ${endpoint}`);
  const [, host, port] = m;
  // -H es --host (¡-h es --help! — verificado contra el usage real del bin).
  const child = spawn(bin, ["-H", host, "-p", port], { stdio: ["ignore", "inherit", "inherit"] });
  child.on("error", () => { /* exit event reporta alive:false — honesto */ });
  return track(child);
}

// Coordinator: factory prod para ForgeDaemon.pooledFactory.
//   peers ordenados → clave warm → spawn llama-server --rpc + wait /health →
//   adapter OpenAI-compatible contra 127.0.0.1:PORT (el front es siempre
//   local; los workers son los que viajan por RPC).
export function makePooledFactory(opts: {
  llamaBin: string;
  portBase?: number; // default 18000 + hash del peer-set
  bootTimeoutMs?: number; // cargar 70B+ tarda — default 300s
}): (inst: DaemonInstance, peers: string[]) => Promise<ForgeExec> {
  const warm = new Map<string, Promise<ForgeExec>>();
  const bootTimeout = opts.bootTimeoutMs ?? 300_000;
  const portFor = (key: string): number => {
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
    return (opts.portBase ?? 18000) + (h % 1000);
  };
  return (inst, peers) => {
    const key = `${inst.instanceId}|${[...peers].sort().join(",")}`;
    const hit = warm.get(key);
    if (hit) return hit;
    const spawned = (async (): Promise<ForgeExec> => {
      if (!inst.modelFile) {
        throw new Error(`instance ${inst.instanceId}: pooled sin modelFile — no puedo spawnear llama-server`);
      }
      const port = portFor(key);
      const args = [
        "-m", inst.modelFile,
        "--rpc", peers.join(","),
        "--split-mode", "layer",
        "--host", "127.0.0.1", // el front SOLO escucha local — los peers van por RPC
        "--port", String(port), // llama-server: --port (no -p — ese es del rpc-server)
      ];
      const child = spawn(opts.llamaBin, args, { stdio: ["ignore", "inherit", "inherit"] });
      const proc = track(child);
      await waitHealthy(`http://127.0.0.1:${port}/health`, bootTimeout, child);
      return new OpenAICompatAdapter({
        forgeId: inst.instanceId,
        model: inst.model,
        baseUrl: `http://127.0.0.1:${port}`,
      });
    })();
    spawned.catch(() => warm.delete(key)); // boot falló → no cachear el rechazo
    warm.set(key, spawned);
    return spawned;
  };
}

// Poll /health hasta que el server cargó el modelo (o el proceso murió).
async function waitHealthy(url: string, timeoutMs: number, child: ChildProcess): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (child.exitCode !== null) throw new Error(`llama-server murió al boot (code ${child.exitCode})`);
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return;
    } catch { /* aún no levanta */ }
    if (Date.now() - t0 > timeoutMs) throw new Error(`llama-server no respondió /health en ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}
