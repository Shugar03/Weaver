export const MAX_SAMPLES = 500; // S11: tope anti-DoS lento. Lo viejo se evicta.
import { JOB_PRICE_USDC } from "@weaver/settlement";
// In-memory = desde el boot (se declara en UI); tabla Postgres viene después (ADR-0002).
export type Sample = {
  forgeId: string;
  model: string;
  ttftMs: number;
  ok: boolean;
  ts: number;
  keyId?: string;
  settle?: { fundTx?: string; releaseTx?: string; status: "pending" | "settled" | "failed" };
};

// S17a — metering: lo consumido por key (o todo el nodo sin key).
export type Usage = { jobs: number; ok: number; okRate: number; spentUSDC: number };

export interface Telemetry {
  record(s: Sample): Promise<void>;
  p50(model: string): Promise<number>;
  recent(n: number): Promise<Sample[]>;
  usage(keyId?: string): Promise<Usage>;
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
  async usage(keyId?: string): Promise<Usage> {
    const xs = keyId ? this.samples.filter((s) => s.keyId === keyId) : this.samples;
    const ok = xs.filter((s) => s.ok).length;
    return {
      jobs: xs.length,
      ok,
      okRate: xs.length === 0 ? 0 : ok / xs.length,
      spentUSDC: Math.round(ok * JOB_PRICE_USDC * 100) / 100,
    };
  }
}
