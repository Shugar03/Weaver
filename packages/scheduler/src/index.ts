// Module Scheduler — única superficie pública (un entry point = Depth).
// Callers y tests cruzan este Seam, nunca los archivos internos.
export { EtrScheduler, etrMs } from "./scheduler.ts";
export { applyBreaker, CircuitBreaker, queueMsFor, DEAD_QUEUE_MS } from "./breaker.ts";
export type { Decision, ForgeView, Job, Scheduler } from "./types.ts";
