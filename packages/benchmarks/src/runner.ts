// Module benchmarks — runner. Mide TTFT/total con clock inyectado.
// En tests el clock es manual (determinista); en vivo es Date.now.
import type { ChatTarget, Measurement, Summary } from "./types.ts";

export async function measure(
  target: ChatTarget,
  prompt: string,
  now: () => number = () => Date.now(),
): Promise<Measurement> {
  const t0 = now();
  try {
    let first = -1;
    let chars = 0;
    for await (const c of target.chat(prompt)) {
      if (first < 0) first = now();
      chars += c.token.length;
      if (c.done) break;
    }
    const t1 = now();
    return { ttftMs: first < 0 ? t1 - t0 : first - t0, totalMs: t1 - t0, chars, ok: true };
  } catch (err) {
    return { ttftMs: -1, totalMs: now() - t0, chars: 0, ok: false, error: String(err) };
  }
}

export function summarize(name: string, ms: Measurement[]): Summary {
  const ok = ms.filter((m) => m.ok);
  const ttfts = ok.map((m) => m.ttftMs).sort((a, b) => a - b);
  return {
    name,
    n: ms.length,
    ok: ok.length,
    p50ttft: ttfts.length > 0 ? ttfts[Math.floor((ttfts.length - 1) / 2)] : -1,
    maxtotal: ok.length > 0 ? Math.max(...ok.map((m) => m.totalMs)) : -1,
    chars: ok.reduce((acc, m) => acc + m.chars, 0),
  };
}

export async function runBench(
  targets: ChatTarget[],
  prompts: string[],
  now: () => number = () => Date.now(),
): Promise<Summary[]> {
  const out: Summary[] = [];
  for (const t of targets) {
    const ms: Measurement[] = [];
    for (const p of prompts) ms.push(await measure(t, p, now));
    out.push(summarize(t.name, ms));
  }
  return out;
}
