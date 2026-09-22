"use client";

// /network — el pipeline causal de un request real, en cuatro etapas:
//   01 FIRE    el usuario dispara un prompt
//   02 ROUTE   la fleet decide — la fila que sirvió flashea (weaver:forge)
//   03 EXECUTE el stream + meta medida (forge, TTFT, ETR)
//   04 SETTLE  lo rendeja la página (server): contrato + payouts on-chain
// Todo lo que se ve es medido; el kill granular vive en las filas de ROUTE.
import { useRef, useState } from "react";
import { runChat, type ForgeView, type RunStatus } from "../../lib/weaver";
import { ThinkingBlock } from "../ThinkingBlock";
import { SectionHead } from "../SectionHead";
import { FleetSection } from "../FleetSection";

const STATUS_LABEL: Record<RunStatus, string> = {
  idle: "listo",
  connecting: "connecting...",
  "forge-selected": "forge selected",
  streaming: "streaming response...",
  completed: "completed",
  error: "error",
};

export function Pipeline({
  base,
  initialForges,
  lastTx,
}: {
  base: string;
  initialForges: ForgeView[] | null;
  lastTx: { label: string; url: string } | null;
}) {
  const [prompt, setPrompt] = useState(
    "Explicá en términos simples qué es el cómputo descentralizado y dame 3 ejemplos reales.",
  );
  const [status, setStatus] = useState<RunStatus>("idle");
  const [statusDetail, setStatusDetail] = useState("");
  const [out, setOut] = useState("");
  const [think, setThink] = useState("");
  const [meta, setMeta] = useState<{ forge: string; ttftMs: number; etrMs: number; reason: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const outRef = useRef<HTMLDivElement>(null);

  async function onRun() {
    if (busy) return;
    setBusy(true);
    setOut("");
    setThink("");
    setMeta(null);
    await runChat(base, "qwen3:4b", prompt, {
      onStatus: (s, detail) => {
        setStatus(s);
        setStatusDetail(detail ?? "");
        if (s === "forge-selected" && detail) {
          window.dispatchEvent(new CustomEvent("weaver:forge", { detail }));
        }
      },
      onReasoning: (t) => {
        setThink((prev) => prev + t);
        outRef.current?.scrollTo({ top: outRef.current.scrollHeight });
      },
      onToken: (t) => {
        setOut((prev) => prev + t);
        outRef.current?.scrollTo({ top: outRef.current.scrollHeight });
      },
      onDone: (m) => {
        setMeta(m);
        setStatus("completed");
        setBusy(false);
      },
      onError: (msg) => {
        setStatus("error");
        setStatusDetail(msg);
        setBusy(false);
      },
    });
  }

  return (
    <>
      {/* 01 — FIRE */}
      <section id="fire" className="scroll-mt-20 pt-10">
        <SectionHead index="01" label="FIRE" right="UN REQUEST REAL ENTRA A LA RED" />
        <div className="grid grid-cols-1 gap-6 border border-line bg-panel p-6 lg:grid-cols-[1fr_auto]">
          <div>
            <div className="mb-2 flex items-center justify-between font-tech text-base tracking-[0.18em] text-fog">
              <span>YOUR PROMPT</span>
              <span>{prompt.length}/2000</span>
            </div>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value.slice(0, 2000))}
              rows={4}
              className="w-full resize-none border border-line bg-void p-4 font-tech text-lg leading-snug text-white outline-none placeholder:text-fog focus:border-lima"
            />
            <div className="mt-3 font-tech text-sm text-fog">
              MODEL fijo para la demo: <span className="text-white">qwen3:4b</span> — la fleet decide qué forge lo sirve ↓
            </div>
          </div>
          <div className="flex flex-col justify-center lg:w-48">
            <button
              onClick={onRun}
              disabled={busy}
              className="flex items-center justify-center gap-3 bg-lima px-8 py-4 text-lg font-bold tracking-wide text-black transition-transform active:translate-y-[1px] disabled:opacity-50"
            >
              <span aria-hidden>▶</span> {busy ? "RUNNING..." : "Run"}
            </button>
            <div className="mt-2 text-center font-tech text-sm text-fog">One action. No decisions.</div>
          </div>
        </div>
      </section>

      {/* 02 — ROUTE */}
      <section id="route" className="scroll-mt-20 pt-14">
        <SectionHead
          index="02"
          label="ROUTE"
          right={initialForges ? `${initialForges.length} FORGES · EL QUE SIRVE FLASHEA` : "GATEWAY CAÍDO"}
        />
        <p className="-mt-3 mb-6 text-sm text-fog">
          La fleet completa — texto e imagen. SIM = standby simulado para demo de failover. KILL/REVIVE por forge (operator key).
        </p>
        <FleetSection base={base} initial={initialForges} />
      </section>

      {/* 03 — EXECUTE */}
      <section id="execute" className="scroll-mt-20 pt-14">
        <SectionHead index="03" label="EXECUTE" right="EL STREAM, TOKEN POR TOKEN" />
        <div className="border border-line bg-panel">
          <div className="flex items-center justify-between border-b border-line px-4 py-2 font-tech text-base tracking-[0.18em] text-fog">
            <span>MODEL OUTPUT (STREAMING)</span>
            <button onClick={() => setOut("")} className="hover:text-white">
              Clear
            </button>
          </div>
          <div className="border-b border-line px-4 py-2 font-tech text-base text-fog">
            <span className="text-lima">&gt;</span> {STATUS_LABEL[status]}
            {statusDetail ? <span className="text-white"> {statusDetail}</span> : null}
          </div>
          <div ref={outRef} className="h-72 overflow-y-auto px-4 py-3 font-tech text-xl leading-snug whitespace-pre-wrap">
            {think && (
              <div className="mb-3">
                <ThinkingBlock text={think} />
              </div>
            )}
            {out || think ? (
              out
            ) : (
              <span className="text-fog">… Esperando RUN. El stream aparece acá, token por token.</span>
            )}
          </div>
          <div className="border-t border-line px-4 py-2 font-tech text-base text-fog">
            {meta ? (
              <span>
                FORGE <span className="text-lima">{meta.forge}</span>
                {"  "}TTFT <span className="text-white">{meta.ttftMs} ms</span>
                {"  "}ETR <span className="text-white">{meta.etrMs} ms</span>
                {"  "}WHY <span className="text-white">{meta.reason}</span>
              </span>
            ) : (
              <span>FORGE — · TTFT — · ETR —</span>
            )}
            {lastTx ? (
              <span title="Último payout on-chain — los chats demo no setlean individualmente">
                {"  "}PAYOUT{" "}
                <a href={lastTx.url} target="_blank" rel="noreferrer" className="text-lima underline">
                  {lastTx.label} ↗
                </a>
              </span>
            ) : null}
          </div>
        </div>
      </section>
    </>
  );
}
