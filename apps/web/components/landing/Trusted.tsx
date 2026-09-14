// Catálogo visión: modelos open-weights reales por nombre.
// Solo qwen3:4b está LIVE; el resto es roadmap declarado (SOON + conteo exacto).
// Marquee CSS puro: loop seamless (lista duplicada), pausa en hover,
// quieto con prefers-reduced-motion. El único marquee de la página.
const MODELS: { id: string; org: string; live?: boolean; kind?: string }[] = [
  { id: "qwen3:4b", org: "Qwen", live: true },
  { id: "llama-3.1:8b", org: "Meta" },
  { id: "mistral:7b", org: "Mistral" },
  { id: "deepseek-r1:8b", org: "DeepSeek" },
  { id: "minimax-m2", org: "MiniMax" },
  { id: "flux.1-schnell", org: "Black Forest", kind: "IMAGE" },
  { id: "smollm3:3b", org: "Hugging Face" },
  { id: "gemma-3:4b", org: "Google" },
  { id: "phi-4-mini", org: "Microsoft" },
  { id: "kimi-k2", org: "Moonshot" },
];

function Chip({ m }: { m: (typeof MODELS)[number] }) {
  return (
    <div className="flex shrink-0 items-center gap-3 border border-line bg-panel px-5 py-3.5">
      <span className={`h-2 w-2 rounded-full ${m.live ? "bg-lima" : "bg-fog"}`} />
      <div>
        <div className="font-tech text-2xl leading-none">{m.id}</div>
        <div className="mt-1 font-tech text-sm tracking-[0.15em] text-fog">
          {m.org.toUpperCase()}
          {m.kind ? ` · ${m.kind}` : ""}
        </div>
      </div>
      <span
        className={`ml-2 px-2 py-0.5 font-tech text-sm tracking-[0.15em] ${
          m.live ? "bg-lima text-black" : "border border-line text-fog"
        }`}
      >
        {m.live ? "LIVE" : "SOON"}
      </span>
    </div>
  );
}

export function Trusted() {
  const live = MODELS.filter((m) => m.live).length;
  return (
    <div className="border-t border-line pt-8">
      <div className="flex items-end justify-between">
        <div className="font-tech text-lg tracking-[0.2em] text-fog">
          <span className="text-lima">{"//"}</span> MODEL CATALOG
        </div>
        <div className="font-tech text-base tracking-[0.15em] text-fog">
          <span className="text-lima">{live} LIVE</span> · {MODELS.length - live} COMING SOON
        </div>
      </div>
      <div className="weaver-marquee mt-6 overflow-hidden" aria-label={`Catálogo: ${live} modelo en vivo, resto roadmap`}>
        <div className="weaver-marquee-track flex w-max gap-4 pr-4">
          {MODELS.map((m) => (
            <Chip key={m.id} m={m} />
          ))}
          {MODELS.map((m) => (
            <Chip key={`dup-${m.id}`} m={m} />
          ))}
        </div>
      </div>
      <div className="mt-3 font-tech text-sm text-fog">
        Nombres reales de pesos abiertos. SOON = roadmap, no inventario: hoy sirve qwen3:4b.
      </div>
    </div>
  );
}
