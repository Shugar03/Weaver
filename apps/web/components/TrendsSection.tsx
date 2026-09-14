type Bench = {
  stamp: number;
  n: number;
  summaries: { name: string; ok: number; p50ttft: number; maxtotal: number }[];
};

export function TrendsSection({ bench }: { bench: Bench | null }) {
  if (!bench || bench.summaries.length === 0) {
    return (
      <div className="border border-line bg-panel p-8 font-tech text-xl text-fog">
        <span className="text-danger">■</span> SIN BENCH — corré{" "}
        <span className="text-white">pnpm --filter @weaver/benchmarks bench</span> con gateway + ollama arriba.
      </div>
    );
  }
  const max = Math.max(...bench.summaries.map((s) => s.p50ttft).filter((v) => v >= 0), 1);
  const gw = bench.summaries.find((s) => s.name === "weaver-gateway");
  const direct = bench.summaries.find((s) => s.name === "ollama-direct");
  const delta =
    gw && direct && gw.p50ttft >= 0 && direct.p50ttft >= 0
      ? Math.round(((direct.p50ttft - gw.p50ttft) / direct.p50ttft) * 100)
      : null;
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <div className="border border-line bg-panel p-6 lg:col-span-2">
        <div className="font-tech text-lg tracking-[0.18em]">TIME TO FIRST TOKEN (TTFT)</div>
        <div className="font-tech text-base text-fog">
          Last benchmark · n = {bench.n} requests · {new Date(bench.stamp).toLocaleString()}
        </div>
        <div className="mt-6 space-y-5">
          {bench.summaries.map((s) => (
            <div key={s.name}>
              <div className="mb-1 flex items-center justify-between font-tech text-lg">
                <span>
                  <span className={`mr-2 inline-block h-2 w-2 rounded-full ${s.name === "weaver-gateway" ? "bg-lima" : "bg-fog"}`} />
                  {s.name === "weaver-gateway" ? "Gateway (Weaver)" : "Direct (Single GPU)"}
                </span>
                <span>{s.p50ttft >= 0 ? `${s.p50ttft.toLocaleString()} ms` : "sin datos"}</span>
              </div>
              <div className="h-10 w-full bg-line/40">
                <div
                  className={`h-10 ${s.name === "weaver-gateway" ? "bg-lima" : "bg-fog"}`}
                  style={{ width: `${s.p50ttft >= 0 ? Math.max(2, Math.round((s.p50ttft / max) * 100)) : 0}%` }}
                />
              </div>
            </div>
          ))}
        </div>
        <div className="mt-4 font-tech text-base text-fog">
          ○ Results vary with forge location, network conditions and model size. n pequeña: leer como orden de magnitud.
        </div>
      </div>
      <div className="flex flex-col justify-center border border-line bg-panel p-6">
        <div className="font-tech text-6xl text-lima">{delta !== null ? `${delta > 0 ? "−" : "+"}${Math.abs(delta)}%` : "—"}</div>
        <div className="mt-1 font-tech text-xl tracking-[0.15em]">OVERHEAD</div>
        <p className="mt-3 text-sm leading-relaxed text-fog">
          Weaver adds routing for global coordination. Warm requests answer in hundreds of ms; cold loads pay once.
        </p>
      </div>
    </div>
  );
}
