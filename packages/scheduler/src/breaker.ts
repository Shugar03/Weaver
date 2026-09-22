// Module Scheduler — CircuitBreaker + carga medida (S27).
// Un forge que falla exec repetidamente (pero cuyo probe responde) hoy mantiene
// su ETR bueno y se intenta primero en CADA request — cada request pagaba un
// intento fallido + failover. El breaker corta eso: threshold fallos en la
// ventana → abierto openMs; un éxito resetea. "Abierto" se presenta como
// queueMs 99999 — el dead-marker que la UI ya muestra (honesto: no-disponible).
import type { ForgeView } from "./types.ts";

export const BREAKER_THRESHOLD = 3;
export const BREAKER_WINDOW_MS = 60_000;
export const BREAKER_OPEN_MS = 30_000;
export const DEAD_QUEUE_MS = 99_999;

export class CircuitBreaker {
  private readonly fails = new Map<string, number[]>();
  private readonly openUntil = new Map<string, number>();

  fail(forgeId: string, now = Date.now()): void {
    const recent = (this.fails.get(forgeId) ?? []).filter((t) => now - t < BREAKER_WINDOW_MS);
    recent.push(now);
    this.fails.set(forgeId, recent);
    if (recent.length >= BREAKER_THRESHOLD) this.openUntil.set(forgeId, now + BREAKER_OPEN_MS);
  }

  ok(forgeId: string): void {
    this.fails.delete(forgeId);
  }

  isOpen(forgeId: string, now = Date.now()): boolean {
    return (this.openUntil.get(forgeId) ?? 0) > now;
  }
}

// queueMs honesto: jobs in-flight × tiempo esperado por job. Sin esto el ETR
// dice medir cola y mide una constante — 10 requests concurrentes iban todos
// al mismo forge aunque serialice.
export function queueMsFor(inFlight: number, expectedMs: number): number {
  return inFlight <= 0 ? 0 : inFlight * expectedMs;
}

// Marca forges con breaker abierto como no-disponibles (dead-marker). Sigue
// siendo candidato de ÚLTIMO recurso en el orden del failover — si todo lo
// demás murió, se intenta igual (half-open real: el intento es el probe).
export function applyBreaker(views: ForgeView[], breaker: CircuitBreaker, now = Date.now()): ForgeView[] {
  return views.map((v) => (breaker.isOpen(v.forgeId, now) ? { ...v, queueMs: DEAD_QUEUE_MS } : v));
}
