// Module Scheduler — Implementation S1: ETR puro, sin precio todavía.
// ETR = RTT + queue + load_si_COLD. Gana el menor ETR.
// S2 agregará score = w1*ETR + w2*price - w3*reliability (Strategy).
import type { Decision, ForgeView, Job, Scheduler } from "./types.js";

export function etrMs(forge: ForgeView, job: Job): number {
  // S20: HOT + medición real → el p50 medido ES el ETR (reemplaza el estimado).
  // Forge frío/muerto: el medido es stale — estimado + load_time.
  const base =
    forge.hot && forge.measuredTtftMs !== undefined
      ? forge.measuredTtftMs + forge.queueMs
      : forge.rttMs + forge.queueMs + (forge.hot ? 0 : forge.loadTimeMs);
  // S28: time-to-result, no time-to-first-token. Con tok/s medido y un job que
  // declara su tamaño, el decode esperado pesa en la elección de forge.
  // Job sin estOutTokens (ping, default) → ETR = llegada del primer token.
  const gen =
    job.estOutTokens !== undefined && forge.tokPerSec !== undefined && forge.tokPerSec > 0
      ? (job.estOutTokens / forge.tokPerSec) * 1000
      : 0;
  const total = base + gen;
  return Number.isFinite(total) && total >= 0 ? total : Number.POSITIVE_INFINITY;
}

// spec 013: ETR efectivo = etrMs × (1 + w·(0.5 − rep)). rep desconocida = 0.5
// → factor 1 (neutral). Con w=0.3 el factor queda en [0.85, 1.15]: la rep
// desempata y gana marginales — jamás pone un forge lento sobre uno muy
// rápido. etrMs=∞ sigue ∞ (la rep no resucita forges muertos).
export function effectiveEtr(forge: ForgeView, job: Job, repWeight: number): number {
  const rep = forge.reputationScore ?? 0.5;
  return etrMs(forge, job) * (1 + repWeight * (0.5 - rep));
}

export class EtrScheduler implements Scheduler {
  private readonly repWeight: number;
  constructor(repWeight = 0) {
    this.repWeight = repWeight;
  }
  select(job: Job, forges: ForgeView[]): Decision {
    if (forges.length === 0) throw new Error("scheduler: sin forges candidatos");
    // S27: sin candidatos del modelo → error explícito. El fallback anterior a
    // "todos los forges" elegía uno que no puede servir el modelo — silencioso.
    const pool = forges.filter((f) => f.model === job.model);
    if (pool.length === 0) throw new Error(`scheduler: sin forges para ${job.model}`);
    let best = pool[0];
    let bestEtr = effectiveEtr(best, job, this.repWeight);
    let pureEtrBest = pool[0];
    let pureEtrBestMs = etrMs(pureEtrBest, job);
    for (const f of pool.slice(1)) {
      const e = effectiveEtr(f, job, this.repWeight);
      if (e < bestEtr) {
        best = f;
        bestEtr = e;
      }
      const pe = etrMs(f, job);
      if (pe < pureEtrBestMs) {
        pureEtrBest = f;
        pureEtrBestMs = pe;
      }
    }
    const baseReason =
      best.hot && best.measuredTtftMs !== undefined
        ? "measured"
        : best.hot
          ? "warm-first"
          : "cold-pero-unico";
    return {
      forgeId: best.forgeId,
      // etrMs reportado = el REAL (calibración honesta), no el ponderado.
      etrMs: etrMs(best, job),
      reason: best === pureEtrBest ? baseReason : `${baseReason}|rep-boost`,
    };
  }
}
