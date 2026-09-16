export const MAX_SAMPLES = 500; // S11: tope anti-DoS lento. Lo viejo se evicta.
// In-memory = desde el boot (se declara en UI); tabla Postgres viene después (ADR-0002).
export type Sample = { forgeId: string; model: string; ttftMs: number; ok: boolean; ts: number; keyId?: string };

export interface Telemetry {
  record(s: Sample): void;
  p50(model: string): number;
  recent(n: number): Sample[];
}

export class InMemoryTelemetry implements Telemetry {
  private samples: Sample[] = [];
  record(s: Sample): void {
    this.samples.push(s);
    if (this.samples.length > MAX_SAMPLES) {
      this.samples.splice(0, this.samples.length - MAX_SAMPLES);
    }
  }
  p50(model: string): number {
    const xs = this.samples.filter((s) => s.model === model && s.ok).map((s) => s.ttftMs).sort((a, b) => a - b);
    if (xs.length === 0) return 0;
    return xs[Math.floor((xs.length - 1) / 2)];
  }
  recent(n: number): Sample[] {
    return this.samples.slice(-Math.max(1, n)).reverse();
  }
}
