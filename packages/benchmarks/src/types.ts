// Module benchmarks — tipos. Vocabulario chico: un Target streamea, el runner mide.
export type Chunk = { token: string; done: boolean };

export interface ChatTarget {
  readonly name: string;
  chat(prompt: string): AsyncIterable<Chunk>;
}

export type Measurement = {
  ttftMs: number;
  totalMs: number;
  chars: number;
  ok: boolean;
  error?: string;
};

export type Summary = {
  name: string;
  n: number;
  ok: number;
  p50ttft: number;
  maxtotal: number;
  chars: number;
};
