// S47 — StagePool (spec 018): reserva atómica de stage-workers y construcción
// de la cadena de pipeline para un coordinator federado. Misma disciplina que
// ForgePool (loans por jobId, reserva pre-probe, strikes → evicción, evicción
// perezosa) — pero el artefacto no es un set de endpoints: es una CADENA
// ORDENADA de (endpoint, blocks[k,n)) que cubre [0..pipeline.blocks) sin
// huecos (Petals: intervalos contiguos — split de bloques rompe latencia).
//
// Chain builder: cobertura greedy por extensión — en cada posición elige el
// stage que llega más lejos (menos fronteras = menos RTT por token), con
// preferencia por forges DISTINTOS del coordinator (descentralización real)
// y menor RTT medido como desempate. D* Lite / costo total = fase B (el
// grafo es chico: ≤6 stages por cadena).
import { tcpProbe } from "./pool.ts";
import type { InstanceReport } from "./protocol.ts";

export type StageWorker = {
  instanceId: string;
  forgePubkey: string;
  model: string;
  endpoint: string;
  layers: [number, number];
  tps?: number;
  rttMs: number;
  live: boolean;
};

// Lo que viaja en job.assign.stages (privado) — instanceId queda interno del
// loan; el coordinator solo necesita endpoint+rango.
export type StageAssign = { endpoint: string; blocks: [number, number] }[];
// El loan guarda la cadena COMPLETA con pubkey — la verificación de
// stageSigs (A4) resuelve endpoint→signer sin tocar el registry (el worker
// pudo desconectarse antes del done; su firma sigue siendo chequeable).
export type StageChainEntry = { endpoint: string; blocks: [number, number]; instanceId: string; forgePubkey: string };
type StageChain = StageChainEntry[];

export type StagePoolDeps = {
  reportOf(instanceId: string): InstanceReport | undefined;
  stageWorkers(): StageWorker[];
  probe?(endpoint: string): Promise<boolean>;
  now?(): number;
};

type Loan = { coordInstance: string; coordPk: string; workers: string[]; chain: StageChain };
type Strike = { n: number; until: number };

const PENALTY_STRIKES = 2;
const EVICT_MS = 120_000;
const MAX_BUILD_ATTEMPTS = 3; // un probe fallido → ban + re-chain, acotado

export class StagePool {
  private readonly deps: StagePoolDeps;
  private readonly loans = new Map<string, Loan>();
  private readonly busy = new Set<string>();
  private readonly strikes = new Map<string, Strike>();
  private readonly probe: (endpoint: string) => Promise<boolean>;
  private readonly now: () => number;

  constructor(deps: StagePoolDeps) {
    this.deps = deps;
    this.probe = deps.probe ?? ((e) => tcpProbe(e));
    this.now = deps.now ?? Date.now;
  }

  // Cadena ordenada para el coordinator, o null si no hay cobertura completa
  // (honesto: falta capacidad → failover del scheduler, jamás cadena hueca).
  // [] = instancia no federada (ruta normal).
  async acquire(instanceId: string, coordinatorPubkey: string, jobId: string): Promise<StageAssign | null> {
    const cfg = this.deps.reportOf(instanceId)?.pipeline;
    if (!cfg) return [];
    this.evictStale();
    const model = this.deps.reportOf(instanceId)!.model;

    for (let attempt = 0; attempt < MAX_BUILD_ATTEMPTS; attempt++) {
      const chain = this.buildChain(model, cfg.blocks, coordinatorPubkey);
      if (!chain) return null; // sin cobertura — nada quedó reservado
      // Reserva atómica PRE-probe: dos acquires concurrentes no se solapan.
      for (const s of chain) this.busy.add(s.instanceId);
      const oks = await Promise.all(chain.map((s) => this.probe(s.endpoint).catch(() => false)));
      if (oks.every(Boolean)) {
        this.loans.set(jobId, { coordInstance: instanceId, coordPk: coordinatorPubkey, workers: chain.map((s) => s.instanceId), chain });
        return chain.map(({ endpoint, blocks }) => ({ endpoint, blocks }));
      }
      // Los que fallaron el probe: strike + se banean para el próximo build.
      // Los sanos: se sueltan (el reintento puede re-elegirlos o no).
      for (const [i, s] of chain.entries()) {
        this.busy.delete(s.instanceId);
        if (!oks[i]) this.strike(s.instanceId);
      }
    }
    return null;
  }

  // Cobertura greedy [0..total): pos avanza al final del stage elegido.
  // Solo LEE — la reserva busy la hace acquire con la cadena ya completa
  // (una cadena parcial nunca queda prestada sin loan: leak real).
  private buildChain(model: string, total: number, coordinatorPubkey: string): StageChain | null {
    const eligible = () =>
      this.deps
        .stageWorkers()
        .filter(
          (w) =>
            w.live &&
            w.model === model &&
            !this.busy.has(w.instanceId) &&
            !this.isPenalized(w.instanceId),
        );
    const chain: StageChain = [];
    const chosen = new Set<string>();
    let pos = 0;
    while (pos < total) {
      const cand = eligible().filter((w) => w.layers[0] <= pos && w.layers[1] > pos && !chosen.has(w.instanceId));
      if (cand.length === 0) return null;
      cand.sort(
        (a, b) =>
          b.layers[1] - a.layers[1] || // mayor extensión = menos fronteras
          Number(a.forgePubkey === coordinatorPubkey) - Number(b.forgePubkey === coordinatorPubkey) ||
          a.rttMs - b.rttMs,
      );
      const w = cand[0];
      chain.push({ endpoint: w.endpoint, blocks: [pos, Math.min(w.layers[1], total)], instanceId: w.instanceId, forgePubkey: w.forgePubkey });
      chosen.add(w.instanceId);
      pos = Math.min(w.layers[1], total);
    }
    return chain;
  }

  // Reemplazo mid-job (stage.need del coordinator): el muerto lo identifica
  // por ENDPOINT — se resuelve a instanceId solo dentro de los workers de
  // ESTE loan (un endpoint ajeno al préstamo no toca nada). Strike al muerto
  // + liberarlo + elegir otro stage que cubra el mismo tramo. El nuevo entra
  // al loan para que release(jobId) lo devuelva al terminar.
  async replace(jobId: string, deadEndpoint: string, blocks: [number, number]): Promise<StageAssign[number] | null> {
    const loan = this.loans.get(jobId);
    if (!loan) return null;
    this.evictStale();
    const workers = this.deps.stageWorkers();
    const dead = workers.find((w) => w.endpoint === deadEndpoint && loan.workers.includes(w.instanceId));
    if (dead) {
      this.strike(dead.instanceId);
      this.busy.delete(dead.instanceId);
      loan.workers = loan.workers.filter((id) => id !== dead.instanceId);
    }
    // El tramo muerto sale de la cadena del loan por ENDPOINT — aunque su
    // instance ya no figure en stageWorkers() (desconectó), ninguna firma
    // suya queda atribuible a este job.
    loan.chain = loan.chain.filter((c) => c.endpoint !== deadEndpoint);
    const model = this.deps.reportOf(loan.coordInstance)?.model;
    const cand = workers
      .filter(
        (w) =>
          w.live &&
          w.model === model &&
          w.layers[0] <= blocks[0] &&
          w.layers[1] >= blocks[1] &&
          w.endpoint !== deadEndpoint && // el muerto NO es su propio reemplazo
          !this.busy.has(w.instanceId) &&
          !this.isPenalized(w.instanceId) &&
          !loan.workers.includes(w.instanceId),
      )
      .sort(
        (a, b) =>
          Number(a.forgePubkey === loan.coordPk) - Number(b.forgePubkey === loan.coordPk) || a.rttMs - b.rttMs,
      );
    if (!cand.length) return null;
    const pick = cand[0];
    this.busy.add(pick.instanceId);
    const ok = await this.probe(pick.endpoint).catch(() => false);
    if (!ok) {
      this.busy.delete(pick.instanceId);
      this.strike(pick.instanceId);
      return null;
    }
    loan.workers.push(pick.instanceId);
    loan.chain.push({ endpoint: pick.endpoint, blocks, instanceId: pick.instanceId, forgePubkey: pick.forgePubkey });
    return { endpoint: pick.endpoint, blocks };
  }

  // La cadena del loan con pubkeys — la verificación de stageSigs resuelve
  // endpoint→signer acá (no en el registry: el worker pudo irse post-done).
  chainOf(jobId: string): StageChain | undefined {
    return this.loans.get(jobId)?.chain.map((c) => ({ ...c }));
  }

  // Una firma de stage que no verifica contra su pubkey = evidencia de
  // trampa o de un stage roto — strike como cualquier falla de protocolo.
  strikeWorker(jobId: string, endpoint: string): void {
    const loan = this.loans.get(jobId);
    const e = loan?.chain.find((c) => c.endpoint === endpoint);
    if (e) this.strike(e.instanceId);
  }

  release(jobId: string): void {
    const loan = this.loans.get(jobId);
    if (!loan) return;
    this.loans.delete(jobId);
    for (const id of loan.workers) this.busy.delete(id);
  }

  penalize(jobId: string): void {
    const loan = this.loans.get(jobId);
    if (!loan) return;
    for (const id of loan.workers) this.strike(id);
  }

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

  private evictStale(): void {
    const alive = new Set(this.deps.stageWorkers().map((w) => w.instanceId));
    for (const id of this.busy) if (!alive.has(id)) this.busy.delete(id);
    const t = this.now();
    for (const [id, s] of this.strikes) {
      if (s.until !== 0 && s.until <= t) this.strikes.delete(id);
    }
  }
}
