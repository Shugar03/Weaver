// Module Telemetry — único que sabe de percentiles. El resto solo hace record().
// Tabla futura: performance_samples(forge_id, model, ttft_ms, tps, ok, at).
export type Sample = { forgeId: string; model: string; ttftMs: number; ok: boolean };

export interface Telemetry {
  record(s: Sample): void;
  p50(model: string): number;
}

export class InMemoryTelemetry implements Telemetry {
  private samples: Sample[] = [];
  record(s: Sample): void {
    this.samples.push(s);
  }
  p50(model: string): number {
    const xs = this.samples.filter((s) => s.model === model && s.ok).map((s) => s.ttftMs).sort((a, b) => a - b);
    if (xs.length === 0) return 0;
    return xs[Math.floor((xs.length - 1) / 2)];
  }
}
