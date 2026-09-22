// Module Scheduler — tipos del dominio (sin infra).
// Vocabulario de CONTEXT.md, nada de HTTP ni Stellar acá.

export type Job = {
  id: string;
  model: string;
  // S28: tokens de salida esperados (max_tokens del request). Sin él el ETR
  // mide TTFT solamente — un ping y un essay de 2k tokens rutean idéntico.
  estOutTokens?: number;
};

export type ForgeView = {
  forgeId: string;
  model: string;
  hot: boolean;
  rttMs: number;
  queueMs: number;
  loadTimeMs: number; // 0 si HOT
  price: number; // USD por job, para S2 (scoring con precio)
  reliability: number; // 0..1
  // S20: TTFT real medido (p50 de telemetry). Si HOT y presente, reemplaza
  // rttMs estimado. Ausente o forge frío → estimado (el medido sería stale).
  measuredTtftMs?: number;
  // S27: carga real medida — jobs corriendo ahora mismo en este forge
  // (TrackedExec). queueMs = inFlight × expectedMs, ya no una constante.
  inFlight?: number;
  // S27: saturated = inFlight ≥ cap del composition root — existe pero no
  // puede tomar jobs ahora (≠ dead: dead no es candidato, saturated sí).
  saturated?: boolean;
  // S28: tok/s medido (telemetría: genTokens/decodeMs de samples con stats).
  // Con esto el ETR deja de ser TTFT-disfrazado para jobs grandes.
  tokPerSec?: number;
  sim?: boolean; // true = capacidad simulada (badge SIM en UI, nunca se hace pasar por real)
  // Modalidad del forge: "text" (chat/tokens) es el default; "image" corre jobs
  // de difusión por el puerto ImageExec — un modelo de imagen jamás es elegible
  // para chat ni aparece en /v1/models (un cliente OpenAI intentaría chatear).
  capability?: "text" | "image";
  // S30: forge remoto (ADR-0005). forgeId = instanceId único; forgePubkey =
  // keypair del forge dueño (identidad + payout address). attested = pasó el
  // benchmark determinístico de registro; sin attestation no es ruteable.
  // remote = llegó por heartbeat WS, no por constante del composition root.
  forgePubkey?: string;
  attested?: boolean;
  remote?: boolean;
};

export type Decision = { forgeId: string; etrMs: number; reason: string };

// Interface del Module — el Seam que testean callers y tests.
export interface Scheduler {
  select(job: Job, forges: ForgeView[]): Decision;
}
