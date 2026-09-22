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
  return base + gen;
}

export class EtrScheduler implements Scheduler {
  select(job: Job, forges: ForgeView[]): Decision {
    if (forges.length === 0) throw new Error("scheduler: sin forges candidatos");
    // S27: sin candidatos del modelo → error explícito. El fallback anterior a
    // "todos los forges" elegía uno que no puede servir el modelo — silencioso.
    const pool = forges.filter((f) => f.model === job.model);
    if (pool.length === 0) throw new Error(`scheduler: sin forges para ${job.model}`);
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
