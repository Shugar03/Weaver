// Module Scheduler — Implementation S1: ETR puro, sin precio todavía.
// ETR = RTT + queue + load_si_COLD + gen_estimado. Gana el menor ETR.
// S2 agregará score = w1*ETR + w2*price - w3*reliability (Strategy).
import type { Decision, ForgeView, Job, Scheduler } from "./types.js";

export function etrMs(forge: ForgeView, job: Job): number {
  const load = forge.hot ? 0 : forge.loadTimeMs;
  return forge.rttMs + forge.queueMs + load + (job.estGenMs ?? 0);
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
      reason: best.hot ? "warm-first" : "cold-pero-unico",
    };
  }
}
