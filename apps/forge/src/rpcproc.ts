// S46 — ciclo de vida de los procesos llama.cpp RPC (spec 017, A2/A3 prod
// + hardening CTO).
//
// Worker (rpc-worker): `ggml-rpc-server -H HOST -p PORT` — presta VRAM por
//   red, el daemon solo reporta su salud (rpcProc.alive → live).
// Coordinator (pool.needs): `llama-server -m MODEL --rpc peers…
//   --split-mode layer --port PORT` spawneado on-demand por peer-set; la
//   factory devuelve un OpenAICompatAdapter contra él.
//
// Garantías (review):
// - Warm cache LRU ACOTADO (maxWarm, default 2): cada entry es un
//   llama-server que puede pesar GBs — un Map infinito = OOM del host.
//   Al evictar se mata el proceso (SIGKILL) — no solo se olvida.
// - Server warm muerto → respawn: el adapter no sirve contra un puerto
//   cadáver; la entrada se respawnea en el próximo job.
// - Puerto con probe: net.listen test antes de spawnear — colisión de hash
//   o de otro proceso → siguiente puerto libre, nunca EADDRINUSE al boot.
// - spawn/healthProbe inyectables → tests sin procesos reales.
//
// SEGURIDAD: endpoints host:port crudos = SOLO LAN/red privada (ADR-0010).
// ggml-rpc-server no tiene auth — sobre WAN abierto esto es superficie de
// ejecución remota. El spec 017 deja el túnel autenticado para Fase B.
import { spawn, type ChildProcess } from "node:child_process";
import { connect, createServer } from "node:net";
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

// Self-probe TCP al endpoint propio — el proceso ggml-rpc-server puede
// seguir vivo con el socket muerto (crash interno del thread de red). El
// heartbeat usa esto como rpcProbe: live = proc vivo Y endpoint alcanzable.
export function probeTcp(endpoint: string, timeoutMs = 800): Promise<boolean> {
  return new Promise((res) => {
    const m = /^(.+):(\d+)$/.exec(endpoint);
    if (!m) return res(false);
    const host = m[1].replace(/^\[|\]$/g, ""); // [::1]:50052 → ::1
    const s = connect({ host, port: Number(m[2]), timeout: timeoutMs });
    const done = (ok: boolean) => {
      s.destroy();
      res(ok);
    };
    s.once("connect", () => done(true));
    s.once("timeout", () => done(false));
    s.once("error", () => done(false));
  });
}

// Worker: spawnea ggml-rpc-server bindeado al host del endpoint anunciado.
// El endpoint ES lo que el coordinator va a dialar — bindear otra iface sería
// mentir en el heartbeat (live:true contra un puerto que no escucha).
// -H es --host (¡-h es --help! — verificado contra el usage real del bin).
export function spawnRpcServer(
  bin: string,
  endpoint: string,
): RpcProc {
  const m = /^(.+):(\d+)$/.exec(endpoint);
  if (!m) throw new Error(`endpoint inválido: ${endpoint}`);
  const [, host, port] = m;
  const child = spawn(bin, ["-H", host, "-p", port], { stdio: ["ignore", "inherit", "inherit"] });
  child.on("error", () => { /* exit event reporta alive:false — honesto */ });
  return track(child);
}

// ¿Puerto libre en 127.0.0.1? net.listen test — detecta colisiones con
// OTROS procesos (no solo los que este daemon trackea).
async function probeFreePort(host: string, port: number): Promise<boolean> {
  return new Promise<boolean>((res) => {
    const s = createServer();
    s.once("error", () => res(false));
    s.once("listening", () => {
      s.close(() => res(true));
    });
    s.listen(port, host);
  });
}

// Puerto libre desde `base` escaneando hacia arriba — deterministic seed por
// peer-set (mismo set → misma zona de puertos) + probe anti-colisión.
async function freePort(host: string, base: number, taken: Set<number>): Promise<number> {
  for (let p = base; p < base + 1000; p++) {
    if (taken.has(p)) continue;
    if (await probeFreePort(host, p)) return p;
  }
  throw new Error(`sin puerto libre en [${base},${base + 1000})`);
}

type WarmEntry = { adapter: ForgeExec; proc: RpcProc; port: number; lastUsed: number };

// Coordinator: factory prod para ForgeDaemon.pooledFactory.
//   peers ordenados → clave warm → spawn llama-server --rpc + health check →
//   adapter OpenAI-compatible contra 127.0.0.1:PORT (el front es siempre
//   local; los workers son los que viajan por RPC).
export function makePooledFactory(opts: {
  llamaBin: string;
  portBase?: number; // default 18000 + hash del peer-set
  bootTimeoutMs?: number; // cargar 70B+ tarda — default 300s
  maxWarm?: number; // servers residentes máx — default 2 (cada uno pesa GBs)
  spawn?: typeof spawn; // inyectable: tests con procesos fake
  healthProbe?: (port: number, child: ChildProcess, timeoutMs: number) => Promise<void>;
}): (inst: DaemonInstance, peers: string[]) => Promise<ForgeExec> {
  const warm = new Map<string, Promise<WarmEntry>>();
  // Recencia accesible síncronamente (lastUsed vive dentro del Promise) —
  // el LRU no puede esperar resolves.
  const recency = new Map<string, number>();
  const bootTimeout = opts.bootTimeoutMs ?? 300_000;
  const maxWarm = opts.maxWarm ?? 2;
  const doSpawn = opts.spawn ?? spawn;
  const healthProbe = opts.healthProbe ?? ((port, child, ms) => waitHealthy(`http://127.0.0.1:${port}/health`, ms, child));
  const baseFor = (key: string): number => {
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
    return (opts.portBase ?? 18000) + (h % 1000);
  };

  const spawnEntry = async (inst: DaemonInstance, peers: string[], key: string): Promise<WarmEntry> => {
    if (!inst.modelFile) {
      throw new Error(`instance ${inst.instanceId}: pooled sin modelFile — no puedo spawnear llama-server`);
    }
    const taken = new Set<number>();
    // Snapshot — warm.values() es iterador VIVO: la llamadora agrega la propia
    // promesa de este spawnEntry al mapa apenas retorna, y el iterador la
    // rendiría → await sobre uno mismo = deadlock (lo probó el test LRU).
    for (const p of [...warm.values()]) {
      try {
        const e = await p;
        taken.add(e.port);
      } catch { /* entrada rota — su puerto no importa */ }
    }
    const base = baseFor(key);
    const port = await freePort("127.0.0.1", base, taken);
    const args = [
      "-m", inst.modelFile,
      "--rpc", peers.join(","),
      "--split-mode", "layer",
      "--host", "127.0.0.1", // el front SOLO escucha local — los peers van por RPC
      "--port", String(port), // llama-server: --port (no -p — ese es del rpc-server)
    ];
    const child = doSpawn(opts.llamaBin, args, { stdio: ["ignore", "inherit", "inherit"] });
    const proc = track(child);
    try {
      await healthProbe(port, child, bootTimeout);
    } catch (e) {
      proc.kill(); // server que no levanta no se queda ocupando VRAM
      throw e;
    }
    return {
      adapter: new OpenAICompatAdapter({
        forgeId: inst.instanceId,
        model: inst.model,
        baseUrl: `http://127.0.0.1:${port}`,
      }),
      proc,
      port,
      lastUsed: Date.now(),
    };
  };

  // LRU: más de maxWarm entries → el menos usado muere (SIGKILL al proceso,
  // no solo fuera del mapa — ese era el leak).
  const evictLru = (): void => {
    if (warm.size <= maxWarm) return;
    let oldestKey = "";
    let oldest = Infinity;
    for (const [k, lastUsed] of recency) {
      if (lastUsed < oldest) {
        oldest = lastUsed;
        oldestKey = k;
      }
    }
    const doomed = warm.get(oldestKey);
    warm.delete(oldestKey);
    recency.delete(oldestKey);
    void doomed?.then((e) => e.proc.kill()).catch(() => {});
  };

  return (inst, peers) => {
    const key = `${inst.instanceId}|${[...peers].sort().join(",")}`;
    const hit = warm.get(key);
    if (hit) {
      // Server warm muerto → no servir contra un cadáver: respawn limpio.
      return hit.then(async (e) => {
        if (e.proc.alive) {
          e.lastUsed = Date.now();
          recency.set(key, e.lastUsed);
          return e.adapter;
        }
        warm.delete(key);
        const fresh = spawnEntry(inst, peers, key);
        warm.set(key, fresh);
        recency.set(key, Date.now());
        fresh.catch(() => {
          warm.delete(key);
          recency.delete(key);
        });
        return (await fresh).adapter;
      });
    }
    const spawned = spawnEntry(inst, peers, key);
    warm.set(key, spawned);
    recency.set(key, Date.now());
    spawned.catch(() => {
      warm.delete(key);
      recency.delete(key);
    }); // boot falló → no cachear el rechazo
    evictLru();
    return spawned.then((e) => e.adapter);
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
