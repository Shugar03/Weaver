// B6 — payout split por stage (spec 018). El payout total del job se reparte:
// share fija del coordinator (COORD_BPS — embed+lm_head+orquestación+front
// risk) y el resto ∝ bloques cubiertos entre las stage-entries VERIFICADAS.
// Una entrada solo llega acá si su stageSig ya verificó (remote.ts) — el
// split jamás paga por tramos declarados pero no firmados. Tramo muerto y
// reemplazado no cobra: cobra quien produjo la firma válida.
// Remainder de redondeo → coordinator (nunca se pierde ni se inventa).
export const COORD_BPS = 2000; // 20% — el coordinator también trabajó

export type StageShareInput = { blocks: [number, number] };

export function computeStageSplit(
  total: number,
  stages: StageShareInput[],
  coordBps = COORD_BPS,
): { coord: number; stageAmounts: number[] } {
  const widths = stages.map((s) => Math.max(0, s.blocks[1] - s.blocks[0]));
  const totalBlocks = widths.reduce((a, b) => a + b, 0);
  const stageAmounts = new Array<number>(stages.length).fill(0);
  if (totalBlocks <= 0 || coordBps >= 10_000) return { coord: total, stageAmounts };
  const pool = Math.floor((total * (10_000 - coordBps)) / 10_000);
  let paid = 0;
  for (let i = 0; i < stages.length; i++) {
    const amount = Math.floor((pool * widths[i]) / totalBlocks);
    stageAmounts[i] = amount;
    paid += amount;
  }
  return { coord: total - paid, stageAmounts };
}
