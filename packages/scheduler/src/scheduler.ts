// Module Scheduler — Implementation S1: ETR puro, sin precio todavía.
// ETR = RTT + queue + load_si_COLD. Gana el menor ETR.
// S2 agregará score = w1*ETR + w2*price - w3*reliability (Strategy).
import type { Decision, ForgeView, Job, Scheduler } from "./types.js";

export function etrMs(forge: ForgeView, _job: Job): number {
  // S20: HOT + medición real → el p50 medido ES el ETR (reemplaza el estimado).
  // Forge frío/muerto: el medido es stale — estimado + load_time.
  if (forge.hot && forge.measuredTtftMs !== undefined) {
    return forge.measuredTtftMs + forge.queueMs;
  }
  return forge.rttMs + forge.queueMs + (forge.hot ? 0 : forge.loadTimeMs);
}

export class EtrScheduler implements Scheduler {
  select(job: Job, forges: ForgeView[]): Decision {
    if (forges.length === 0) throw new Error("scheduler: sin forges candidatos");
    const sameModel = forges.filter((f) => f.model === job.model);
    const pool = sameModel.length > 0 ? sameModel : forges;
    let best = pool[0];
    let bestEtr = etrMs(best, job);
    for (const f of pool.slice(1)) {
      const e = etrMs(f, job);
      if (e < bestEtr) {
        best = f;
        bestEtr = e;
      }
    }
    return {
      forgeId: best.forgeId,
      etrMs: bestEtr,
      reason:
        best.hot && best.measuredTtftMs !== undefined
          ? "measured"
          : best.hot
            ? "warm-first"
            : "cold-pero-unico",
    };
  }
}
