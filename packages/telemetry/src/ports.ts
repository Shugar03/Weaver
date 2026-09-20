export const MAX_SAMPLES = 500; // S11: tope anti-DoS lento. Lo viejo se evicta.
// In-memory = desde el boot (se declara en UI); tabla Postgres viene después (ADR-0002).
export type Sample = { forgeId: string; model: string; ttftMs: number; ok: boolean; ts: number; keyId?: string };

export interface Telemetry {
  record(s: Sample): Promise<void>;
  p50(model: string): Promise<number>;
  recent(n: number): Promise<Sample[]>;
}

export class InMemoryTelemetry implements Telemetry {
  private samples: Sample[] = [];
  async record(s: Sample): Promise<void> {
    this.samples.push(s);
    if (this.samples.length > MAX_SAMPLES) {
      this.samples.splice(0, this.samples.length - MAX_SAMPLES);
    }
  }
  async p50(model: string): Promise<number> {
    const xs = this.samples.filter((s) => s.model === model && s.ok).map((s) => s.ttftMs).sort((a, b) => a - b);
    if (xs.length === 0) return 0;
    return xs[Math.floor((xs.length - 1) / 2)];
  }
  async recent(n: number): Promise<Sample[]> {
    return this.samples.slice(-Math.max(1, n)).reverse();
  }
}
