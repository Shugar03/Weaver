// S46 — ForgePool (spec 017 + hardening): reserva atómica de rpc-workers
// para un coordinator pooled. El scheduler nunca ve workers (no son rutas):
// el pairing ocurre acá, en el instante del assign.
//
// Garantías (review CTO):
// - Loans por jobId — dos jobs al mismo coordinator nunca se pisan el
//   préstamo (antes: keyed por instanceId → leak/oversuscripción real).
// - Reserva PRE-probe: los candidatos se marcan busy ANTES del await — dos
//   acquires concurrentes no pueden elegir el mismo worker (atomicidad).
// - Probe TCP al endpoint: un worker que heartbeatea live pero no acepta
//   conexiones nunca llega al job.assign (endpoint envenenado → strike).
// - Strikes → evicción temporal: un peer que hace fallar el spawn pooled
//   (poolBlame del daemon) o que rechaza el probe acumula faltas; a la
//   segunda queda fuera por EVICT_MS — el mismo worker malo no vuelve a
//   envenenar el retry del failover. Self-heal tras el cooldown.
// - minVramGb: workers que no declaran o no alcanzan la VRAM mínima no son
//   elegibles — capacidad filtrada antes del préstamo, no descubierta al
//   crash. Sin vramGb declarado + filtro activo → conservador: fuera.
// - Worker muerto → sale de workers() por heartbeat TTL; su busy queda
//   stale y se evicia perezoso en el próximo acquire.
import { connect } from "node:net";
import type { InstanceReport } from "./protocol.ts";

export type PoolWorker = {
  instanceId: string;
  forgePubkey: string;
  endpoint: string;
  vramGb?: number;
  rttMs: number;
  live: boolean;
};

export type PoolDeps = {
  reportOf(instanceId: string): InstanceReport | undefined;
  workers(): PoolWorker[];
  // Probe TCP del endpoint antes de prestar — inyectable en tests.
  // Default: net.connect con timeout (ver tcpProbe).
  probe?(endpoint: string): Promise<boolean>;
  now?(): number;
};

type Loan = { coordInstance: string; coordPk: string; workers: string[] };
type Strike = { n: number; until: number };

const PENALTY_STRIKES = 2; // faltas antes de evictar
const EVICT_MS = 120_000; // cooldown del worker penalizado (self-heal después)
const PROBE_MS = 800; // timeout TCP por endpoint — paralelo, acotado
const SPARE = 2; // candidatos extra por si el probe descarta alguno

// TCP real: ¿el endpoint acepta conexiones? Solo eso probamos — el handshake
// ggml-rpc lo valida el coordinator al spawnear (y reporta poolBlame).
export function tcpProbe(endpoint: string, ms = PROBE_MS): Promise<boolean> {
  const m = /^(.+):(\d+)$/.exec(endpoint);
  if (!m) return Promise.resolve(false);
  const host = m[1].replace(/^\[|\]$/g, ""); // [::1] → ::1
  const port = Number(m[2]);
  return new Promise<boolean>((res) => {
    const s = connect({ host, port, timeout: ms });
    const done = (ok: boolean) => {
      s.destroy();
      res(ok);
    };
    s.once("connect", () => done(true));
    s.once("timeout", () => done(false));
    s.once("error", () => done(false));
  });
}

export class ForgePool {
  private readonly deps: PoolDeps;
  private readonly loans = new Map<string, Loan>(); // jobId → préstamo
  private readonly busy = new Set<string>(); // workerIds actualmente prestados
  private readonly strikes = new Map<string, Strike>(); // workerId → faltas
  private readonly probe: (endpoint: string) => Promise<boolean>;
  private readonly now: () => number;

  constructor(deps: PoolDeps) {
    this.deps = deps;
    this.probe = deps.probe ?? ((e) => tcpProbe(e));
    this.now = deps.now ?? Date.now;
  }

  // Endpoints para el coordinator, o null si no hay workers elegibles
  // suficientes. [] = instancia no pooled (ruta normal).
  // Async: el probe TCP viaja antes del assign — la reserva busy se hace
  // ANTES del await para que un acquire concurrente no solape candidatos.
  async acquire(instanceId: string, coordinatorPubkey: string, jobId: string): Promise<string[] | null> {
    const cfg = this.deps.reportOf(instanceId)?.pool;
    if (!cfg) return [];
    this.evictStale();
    const min = cfg.minVramGb;
    const free = this.deps
      .workers()
      .filter(
        (w) =>
          w.live &&
          !this.busy.has(w.instanceId) &&
          !this.isPenalized(w.instanceId) &&
          (min === undefined || (w.vramGb !== undefined && w.vramGb >= min)),
      )
      .sort(
        (a, b) =>
          Number(a.forgePubkey === coordinatorPubkey) - Number(b.forgePubkey === coordinatorPubkey) || a.rttMs - b.rttMs,
      );
    if (free.length < cfg.needs) return null;
    // Reserva atómica PRE-probe: tomamos hasta needs*SPARE candidatos para
    // tolerar descartes sin segundo round-trip al registry.
    const cand = free.slice(0, cfg.needs * SPARE);
    for (const c of cand) this.busy.add(c.instanceId);
    const oks = await Promise.all(cand.map((c) => this.probe(c.endpoint).catch(() => false)));
    // Los que no aceptan TCP: strike + devueltos. Los spare sanos: devueltos.
    const chosen: PoolWorker[] = [];
    for (const [i, c] of cand.entries()) {
      if (oks[i] && chosen.length < cfg.needs) {
        chosen.push(c);
      } else {
        this.busy.delete(c.instanceId);
        if (!oks[i]) this.strike(c.instanceId);
      }
    }
    if (chosen.length < cfg.needs) {
      for (const g of chosen) this.busy.delete(g.instanceId);
      return null;
    }
    this.loans.set(jobId, { coordInstance: instanceId, coordPk: coordinatorPubkey, workers: chosen.map((w) => w.instanceId) });
    return chosen.map((w) => w.endpoint);
  }

  // Fin del job (done/fail/cancel): los workers DE ESE job vuelven al pool.
  // Idempotente — release sobre jobId sin loan no hace nada.
  release(jobId: string): void {
    const loan = this.loans.get(jobId);
    if (!loan) return;
    this.loans.delete(jobId);
    for (const id of loan.workers) this.busy.delete(id);
  }

  // El job falló por culpa de los peers (job.fail poolBlame del daemon):
  // strike a cada worker del préstamo — a la segunda falta queda evictado.
  // No liberamos acá: el release es responsabilidad del caller (finally).
  penalize(jobId: string): void {
    const loan = this.loans.get(jobId);
    if (!loan) return;
    for (const id of loan.workers) this.strike(id);
  }

  // Forge del coordinator muerto (su socket cerró): libera TODOS sus loans.
  releaseForge(coordinatorPubkey: string): void {
    for (const [jobId, loan] of [...this.loans]) {
      if (loan.coordPk !== coordinatorPubkey) continue;
      this.loans.delete(jobId);
      for (const id of loan.workers) this.busy.delete(id);
    }
  }

  private isPenalized(workerId: string): boolean {
    const s = this.strikes.get(workerId);
    return s !== undefined && s.n >= PENALTY_STRIKES && s.until > this.now();
  }

  private strike(workerId: string): void {
    const s = this.strikes.get(workerId) ?? { n: 0, until: 0 };
    s.n += 1;
    if (s.n >= PENALTY_STRIKES) s.until = this.now() + EVICT_MS;
    this.strikes.set(workerId, s);
  }

  // Evicción perezosa: busy de workers que dejaron de heartbeatear, y
  // strikes cuyo cooldown ya venció. Corre al inicio de cada acquire.
  private evictStale(): void {
    const alive = new Set(this.deps.workers().map((w) => w.instanceId));
    for (const id of this.busy) if (!alive.has(id)) this.busy.delete(id);
    const t = this.now();
    for (const [id, s] of this.strikes) {
      if (s.until !== 0 && s.until <= t) this.strikes.delete(id);
    }
  }
}
