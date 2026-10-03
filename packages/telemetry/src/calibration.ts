// Module Telemetry — calibración del ETR: contrasta lo que el router predijo
// contra lo que el job tardó de verdad. Cierra el loop del claim central del
// producto ("measured, not declared") — visible, no escondido.
import type { Sample } from "./ports.ts";

const ALPHA = 0.3; // misma constante de EMA que el resto del sistema
const WINDOW = 20; // últimas N ejecuciones calibrables por forge

export type EtrCalibration = {
  // Error relativo EMA: |predicho - real| / real, en %. 0 = el router clava.
  errPct: number;
  // Último par observado — la UI muestra "pred X → real Y".
  lastPredMs: number;
  lastActualMs: number;
};

export function etrCalibration(samples: Sample[], forgeId: string): EtrCalibration | null {
  const pairs = samples
    .filter((s) => s.forgeId === forgeId && s.ok && s.predictedMs !== undefined)
    .slice(-WINDOW);
  if (pairs.length === 0) return null;
  let ema: number | undefined;
  let lastPred = 0;
  let lastAct = 0;
  for (const s of pairs) {
    const act = s.ttftMs + (s.decodeMs ?? 0);
    if (act <= 0) continue;
    const err = Math.abs(s.predictedMs! - act) / act;
    ema = ema === undefined ? err : (1 - ALPHA) * ema + ALPHA * err;
    lastPred = s.predictedMs!;
    lastAct = act;
  }
  if (ema === undefined) return null;
  return { errPct: Math.round(ema * 100), lastPredMs: Math.round(lastPred), lastActualMs: Math.round(lastAct) };
}
