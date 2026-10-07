// S46 — ForgePool (spec 017): reserva atómica de rpc-workers para un
// coordinator pooled. El scheduler nunca ve workers (no son rutas): el
// pairing ocurre acá, en el instante del assign — misma disciplina que la
// reserva de inFlight: acquire con el dispatch, release con el fin del job.
//
// Worker muerto → sale de workers() por heartbeat TTL; su entrada `busy`
// queda stale y se evicia perezosamente en el próximo acquire (self-heal,
// sin listeners extra). La verdad viva es SIEMPRE el registry.
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
};

type Loan = { coordinatorPk: string; workers: string[] };

export class ForgePool {
  private readonly deps: PoolDeps;
  private readonly loans = new Map<string, Loan>(); // coordinatorId → préstamo
  private readonly busy = new Set<string>(); // workerIds actualmente prestados

  constructor(deps: PoolDeps) {
    this.deps = deps;
  }

  // Endpoints para el coordinator, o null si la instancia pide pool y no hay
  // workers libres suficientes. [] = la instancia no es pooled (normal).
  // Preferencia: workers de OTRO forge (el claim "desconocidos combinan
  // GPUs"), empatados por RTT medido — cadena más corta primero (Petals-style).
  acquire(instanceId: string, coordinatorPubkey: string): string[] | null {
    const needs = this.deps.reportOf(instanceId)?.pool?.needs ?? 0;
    if (needs === 0) return [];
    // Evicción perezosa: busy de workers que ya no heartbeatean.
    const ws = this.deps.workers();
    const alive = new Set(ws.map((w) => w.instanceId));
    for (const id of this.busy) if (!alive.has(id)) this.busy.delete(id);
    const free = ws
      .filter((w) => w.live && !this.busy.has(w.instanceId))
      .sort((a, b) => Number(a.forgePubkey === coordinatorPubkey) - Number(b.forgePubkey === coordinatorPubkey) || a.rttMs - b.rttMs);
    if (free.length < needs) return null;
    const chosen = free.slice(0, needs);
    for (const w of chosen) this.busy.add(w.instanceId);
    this.loans.set(instanceId, { coordinatorPk: coordinatorPubkey, workers: chosen.map((w) => w.instanceId) });
    return chosen.map((w) => w.endpoint);
  }

  // Fin del job (done/fail/cancel/coord muerto): los workers vuelven al pool.
  // Idempotente — release sobre un loan ya liberado no hace nada.
  release(instanceId: string): void {
    const loan = this.loans.get(instanceId);
    if (!loan) return;
    this.loans.delete(instanceId);
    for (const id of loan.workers) this.busy.delete(id);
  }

  // Forge del coordinator muerto (su socket cerró): libera sus loans. Los
  // workers muertos se curan solos por evicción perezosa en acquire.
  releaseForge(coordinatorPubkey: string): void {
    for (const [coord, loan] of [...this.loans]) {
      if (loan.coordinatorPk !== coordinatorPubkey) continue;
      this.loans.delete(coord);
      for (const id of loan.workers) this.busy.delete(id);
    }
  }
}
