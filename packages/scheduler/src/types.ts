// Module Scheduler — tipos del dominio (sin infra).
// Vocabulario de CONTEXT.md, nada de HTTP ni Stellar acá.

export type Job = { id: string; model: string; estGenMs?: number };

export type ForgeView = {
  forgeId: string;
  model: string;
  hot: boolean;
  rttMs: number;
  queueMs: number;
  loadTimeMs: number; // 0 si HOT
  price: number; // USD por job, para S2 (scoring con precio)
  reliability: number; // 0..1
  sim?: boolean; // true = capacidad simulada (badge SIM en UI, nunca se hace pasar por real)
};

export type Decision = { forgeId: string; etrMs: number; reason: string };

// Interface del Module — el Seam que testean callers y tests.
export interface Scheduler {
  select(job: Job, forges: ForgeView[]): Decision;
}
