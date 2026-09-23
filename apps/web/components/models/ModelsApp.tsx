"use client";

// /models — marketplace. Mental model OpenRouter/HF (Jakob): tabla densa con
// search + chips de feature + toggle "available now". Orden curado: available
// primero, luego medido, luego declarado — sin sort alfabético ciego (Hick:
// los defaults hacen la elección). Lo no medido muestra "—", no ceros.
import { useEffect, useMemo, useState } from "react";
import { MagnifyingGlass } from "@phosphor-icons/react";
import { getCatalog, usdPerMtok, fmtCtx, filterModels, type CatalogModel } from "../../lib/catalog";

const FEATURE_CHIPS = ["tools", "reasoning", "vision", "image", "json", "audio", "video"];

export function ModelsApp({ base }: { base: string }) {
  const [models, setModels] = useState<CatalogModel[] | null>(null);
  const [err, setErr] = useState(false);
  const [q, setQ] = useState("");
  const [feat, setFeat] = useState<string | null>(null);
  const [onlyAvail, setOnlyAvail] = useState(false);

  useEffect(() => {
    void getCatalog(base).then((m) => {
      if (m === null) setErr(true);
      setModels(m);
    });
    const id = setInterval(() => {
      void getCatalog(base).then((m) => {
        if (m !== null) setModels(m);
      });
    }, 15_000);
    return () => clearInterval(id);
  }, [base]);

  const list = useMemo(() => filterModels(models ?? [], { q, feat, onlyAvail }), [models, q, feat, onlyAvail]);

  return (
    <main className="mx-auto max-w-7xl px-4 pb-16 md:px-6">
      <section className="pt-10 pb-6">
        <div className="font-tech text-lg tracking-[0.2em] text-fog">
          <span className="text-lima">{"//"}</span> MODELS
        </div>
        <h1 className="mt-3 text-4xl font-bold tracking-tight md:text-5xl">
          Marketplace<span className="text-lima">.</span>
        </h1>
        <p className="mt-3 max-w-[62ch] text-sm leading-relaxed text-fog">
          Modelos servidos por la fleet — providers vivos, precios declarados y performance{" "}
          <span className="text-white">medida</span> (p50 TTFT, tok/s). Lo que no está medido muestra
          &quot;—&quot;, no marketing.
        </p>
      </section>

      {/* toolbar: search + chips + availability */}
      <div className="flex flex-wrap items-center gap-3 border border-line bg-panel p-3">
        <label className="flex min-w-0 flex-1 items-center gap-2 border border-line bg-void px-3 py-2 focus-within:border-lima">
          <MagnifyingGlass size={16} className="shrink-0 text-fog" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="buscar modelo…"
            spellCheck={false}
            className="w-full bg-transparent font-tech text-base text-white outline-none placeholder:text-fog/50"
          />
        </label>
        <div className="flex flex-wrap gap-1">
          {FEATURE_CHIPS.map((f) => (
            <button
              key={f}
              onClick={() => setFeat(feat === f ? null : f)}
              className={`px-2.5 py-1 font-tech text-sm tracking-[0.1em] transition-colors ${
                feat === f ? "bg-lima text-black" : "border border-line text-fog hover:text-white"
              }`}
            >
              {f}
            </button>
          ))}
          <button
            onClick={() => setOnlyAvail(!onlyAvail)}
            className={`px-2.5 py-1 font-tech text-sm tracking-[0.1em] transition-colors ${
              onlyAvail ? "bg-lima text-black" : "border border-line text-fog hover:text-white"
            }`}
          >
            live now
          </button>
        </div>
      </div>

      {/* tabla */}
      {models === null && !err ? (
        <div className="mt-4 space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-16 animate-pulse border border-line bg-panel" />
          ))}
        </div>
      ) : err || models === null ? (
        <div className="mt-4 border border-danger/60 bg-danger/10 px-4 py-6 text-center font-tech text-lg text-danger">
          gateway sin respuesta — el catálogo no se pudo cargar
        </div>
      ) : list.length === 0 ? (
        <div className="mt-4 border border-line bg-panel p-8 text-center">
          <div className="font-tech text-xl text-fog">sin resultados</div>
          <p className="mt-2 text-sm text-fog">Probá con otro término o sacá filtros.</p>
        </div>
      ) : (
        <div className="mt-4 border border-line bg-panel">
          <div className="hidden grid-cols-[1.4fr_auto_auto_auto_auto_auto_auto] items-center gap-x-5 border-b border-line px-4 py-2 font-tech text-xs tracking-[0.2em] text-fog md:grid">
            <span>MODEL</span>
            <span className="text-right">CTX</span>
            <span className="text-right">$/Mtok IN</span>
            <span className="text-right">$/Mtok OUT</span>
            <span className="text-right">TTFT p50</span>
            <span className="text-right">tok/s</span>
            <span className="text-right">PROVIDERS</span>
          </div>
          <ul>
            {list.map((m) => {
              const pin = usdPerMtok(m.pricing.prompt);
              const pout = usdPerMtok(m.pricing.completion);
              const pimg = usdPerMtok(m.pricing.image);
              return (
                <li key={m.id}>
                  <a
                    href={`/models/${encodeURIComponent(m.id)}`}
                    className="block border-b border-line/60 px-4 py-3 transition-colors last:border-b-0 hover:bg-void"
                  >
                    {/* fila densa desktop / stacked mobile */}
                    <div className="grid grid-cols-1 gap-y-1 md:grid-cols-[1.4fr_auto_auto_auto_auto_auto_auto] md:items-center md:gap-x-5">
                      <span className="min-w-0">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="truncate font-tech text-lg text-white">{m.name ?? m.id}</span>
                          {m.availability.available ? (
                            <span className="bg-lima/15 px-1.5 py-0.5 font-tech text-xs text-lima">LIVE</span>
                          ) : (
                            <span className="bg-line px-1.5 py-0.5 font-tech text-xs text-fog">OFFLINE</span>
                          )}
                          {m.features.map((f) => (
                            <span key={f} className="border border-line px-1.5 py-0.5 font-tech text-xs text-fog">
                              {f}
                            </span>
                          ))}
                          {!m.declared && (
                            <span className="border border-dashed border-line px-1.5 py-0.5 font-tech text-xs text-fog/70">
                              not declared
                            </span>
                          )}
                        </span>
                        {m.name && <span className="block truncate font-tech text-sm text-fog">{m.id}</span>}
                      </span>
                      <span className="font-tech text-base text-fog md:text-right">{fmtCtx(m.context)}</span>
                      <span className="font-tech text-base text-fog md:text-right">
                        {pin !== null ? `$${pin.toFixed(3)}` : pimg !== null ? `$${pimg.toFixed(3)}/img` : "—"}
                      </span>
                      <span className="font-tech text-base text-fog md:text-right">
                        {pout !== null ? `$${pout.toFixed(3)}` : "—"}
                      </span>
                      <span className="font-tech text-base md:text-right">
                        {m.measured.ttftMsP50 !== null ? (
                          <span className="text-white">{m.measured.ttftMsP50}ms</span>
                        ) : (
                          <span className="text-fog/60">—</span>
                        )}
                      </span>
                      <span className="font-tech text-base md:text-right">
                        {m.measured.tokPerSec !== null ? (
                          <span className="text-white">{m.measured.tokPerSec.toFixed(1)}</span>
                        ) : (
                          <span className="text-fog/60">—</span>
                        )}
                      </span>
                      <span className="font-tech text-base text-fog md:text-right">
                        {m.availability.providers}
                        {m.availability.hot > 0 && <span className="text-lima"> ({m.availability.hot} hot)</span>}
                      </span>
                    </div>
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <div className="mt-3 font-tech text-sm text-fog">
        * precios en USD por millón de tokens (declarados en MODEL_PRICING). TTFT/tok·s medidos de telemetría real;
        &quot;—&quot; = sin samples todavía.
      </div>
    </main>
  );
}
