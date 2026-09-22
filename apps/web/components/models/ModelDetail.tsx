"use client";

// /models/[id] — detalle de modelo. Specs agrupadas (chunking): identidad,
// capacidades, contexto, pricing, medido, providers. Medido solo si hay
// samples — "sin medición" explícito si no. Snippet + CTA a chat.
import { useEffect, useState } from "react";
import { ArrowRight, ArrowSquareOut } from "@phosphor-icons/react";
import { getCatalog, usdPerMtok, fmtCtx, type CatalogModel } from "../../lib/catalog";
import { CodeBlock } from "../CodeBlock";

function Spec({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="border border-line bg-void p-3">
      <div className="font-tech text-xs tracking-[0.2em] text-fog">{label}</div>
      <div className={`mt-1 text-base text-white ${mono ? "font-tech" : ""}`}>{value}</div>
    </div>
  );
}

export function ModelDetail({ base, id }: { base: string; id: string }) {
  const [m, setM] = useState<CatalogModel | null>(null);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    const load = () =>
      getCatalog(base).then((all) => {
        if (all === null) {
          setGone(true);
          return;
        }
        setGone(false);
        setM(all.find((x) => x.id === id) ?? null);
      });
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [base, id]);

  if (gone) {
    return (
      <main className="mx-auto max-w-5xl px-4 pb-16 md:px-6">
        <div className="mt-10 border border-danger/60 bg-danger/10 px-4 py-6 text-center font-tech text-lg text-danger">
          gateway sin respuesta
        </div>
      </main>
    );
  }
  if (!m) {
    return (
      <main className="mx-auto max-w-5xl px-4 pb-16 md:px-6">
        <div className="mt-10 h-40 animate-pulse border border-line bg-panel" />
      </main>
    );
  }

  const pin = usdPerMtok(m.pricing.prompt);
  const pout = usdPerMtok(m.pricing.completion);
  const pimg = usdPerMtok(m.pricing.image);
  const snippet = `curl ${base}/v1/chat/completions \\
  -H "Authorization: Bearer wvr_TU_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"${m.id}","messages":[{"role":"user","content":"hola"}],"stream":true}'`;

  return (
    <main className="mx-auto max-w-5xl px-4 pb-16 md:px-6">
      {/* header */}
      <section className="pt-10">
        <div className="font-tech text-sm tracking-[0.2em] text-fog">
          <a href="/models" className="hover:text-lima">MODELS</a>
          <span className="text-lima"> / </span>
          {m.id}
        </div>
        <h1 className="mt-3 text-4xl font-bold tracking-tight md:text-5xl">{m.name ?? m.id}</h1>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {m.availability.available ? (
            <span className="bg-lima/15 px-2 py-1 font-tech text-sm text-lima">LIVE — {m.availability.providers} providers</span>
          ) : (
            <span className="bg-line px-2 py-1 font-tech text-sm text-fog">OFFLINE</span>
          )}
          {m.features.map((f) => (
            <span key={f} className="border border-line px-2 py-1 font-tech text-sm text-fog">{f}</span>
          ))}
          {!m.declared && (
            <span className="border border-dashed border-line px-2 py-1 font-tech text-sm text-fog/70">metadata not declared</span>
          )}
          {m.docs && (
            <a href={m.docs} target="_blank" rel="noreferrer" className="flex items-center gap-1 px-2 py-1 font-tech text-sm text-lima hover:text-white">
              docs <ArrowSquareOut size={14} />
            </a>
          )}
        </div>
        {m.description && <p className="mt-4 max-w-[62ch] text-sm leading-relaxed text-fog">{m.description}</p>}
      </section>

      {/* specs agrupadas */}
      <section className="mt-8 grid grid-cols-2 gap-2 md:grid-cols-4">
        <Spec label="MODEL ID" value={m.id} />
        <Spec label="CONTEXT" value={m.context !== null ? `${fmtCtx(m.context)} tokens` : "not declared"} />
        <Spec label="PROVIDERS" value={`${m.availability.providers} (${m.availability.hot} hot)`} />
        <Spec label="STATUS" value={m.availability.available ? "available" : "offline"} />
      </section>

      <section className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-4">
        <Spec label="INPUT" value={pin !== null ? `$${pin.toFixed(3)}/Mtok` : "not declared"} />
        <Spec label="OUTPUT" value={pout !== null ? `$${pout.toFixed(3)}/Mtok` : "not declared"} />
        <Spec label="IMAGE" value={pimg !== null ? `$${pimg.toFixed(3)}/gen` : "—"} />
        <Spec label="BILLING" value="prepaid USDC · measured" />
      </section>

      {/* medido — honesto: sin samples se dice */}
      <section className="mt-6 border border-line bg-panel p-5">
        <div className="font-tech text-sm tracking-[0.2em] text-fog">MEASURED PERFORMANCE</div>
        {m.measured.ttftMsP50 === null && m.measured.tokPerSec === null ? (
          <p className="mt-2 font-tech text-base text-fog">
            sin medición todavía — el primer request de este modelo deja samples acá
          </p>
        ) : (
          <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-3">
            <Spec label="TTFT p50" value={m.measured.ttftMsP50 !== null ? `${m.measured.ttftMsP50} ms` : "—"} />
            <Spec label="TOK/S" value={m.measured.tokPerSec !== null ? m.measured.tokPerSec.toFixed(1) : "—"} />
            <Spec label="SOURCE" value="gateway telemetry" />
          </div>
        )}
      </section>

      {/* uso */}
      <section className="mt-6">
        <div className="font-tech text-sm tracking-[0.2em] text-fog">USE IT</div>
        <div className="mt-3">
          <CodeBlock title="curl" lang="bash" code={snippet} />
        </div>
        <div className="mt-4 flex flex-wrap gap-3">
          <a
            href={`/chat?model=${encodeURIComponent(m.id)}`}
            className="flex items-center gap-2 bg-lima px-5 py-3 font-tech text-lg tracking-[0.15em] text-black transition-colors hover:bg-white"
          >
            TRY IN CHAT <ArrowRight size={18} weight="bold" />
          </a>
          <a
            href="/account"
            className="border border-line px-5 py-3 font-tech text-lg tracking-[0.15em] text-fog transition-colors hover:text-white"
          >
            GET AN API KEY
          </a>
        </div>
      </section>
    </main>
  );
}
