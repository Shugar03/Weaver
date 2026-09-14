"use client";

import { useRef, useState } from "react";
import { runChat, setKill, type RunStatus } from "../lib/weaver";

const STATUS_LABEL: Record<RunStatus, string> = {
  idle: "listo",
  connecting: "connecting...",
  "forge-selected": "forge selected",
  streaming: "streaming response...",
  completed: "completed",
  error: "error",
};

const MODELS = [
  { id: "qwen3:4b", sub: "4B", active: true },
  { id: "llama-3.1:8b", sub: "8B", active: false },
  { id: "mistral:7b", sub: "7B", active: false },
  { id: "deepseek:7b", sub: "7B", active: false },
];

export function RunPanel({ base, lastTx }: { base: string; lastTx: { label: string; url: string } | null }) {
  const [prompt, setPrompt] = useState(
    "Explicá en términos simples qué es el cómputo descentralizado y dame 3 ejemplos reales.",
  );
  const [status, setStatus] = useState<RunStatus>("idle");
  const [statusDetail, setStatusDetail] = useState("");
  const [out, setOut] = useState("");
  const [meta, setMeta] = useState<{ forge: string; ttftMs: number; etrMs: number; reason: string } | null>(null);
  const [dead, setDead] = useState(false);
  const [busy, setBusy] = useState(false);
  const outRef = useRef<HTMLDivElement>(null);

  async function onRun() {
    if (busy) return;
    setBusy(true);
    setOut("");
    setMeta(null);
    await runChat(base, "qwen3:4b", prompt, {
      onStatus: (s, detail) => {
        setStatus(s);
        setStatusDetail(detail ?? "");
        if (s === "forge-selected" && detail) {
          window.dispatchEvent(new CustomEvent("weaver:forge", { detail }));
        }
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

  async function onKillToggle() {
    try {
      await setKill(base, !dead);
      setDead(!dead);
    } catch {
      setStatus("error");
      setStatusDetail("gateway caído — levantá :3001");
    }
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      {/* izquierda: prompt + run */}
      <div className="border border-line bg-panel p-6">
        <h1 className="text-4xl leading-[1.05] font-bold tracking-tight md:text-5xl">
          Real AI.
          <br />
          <span className="text-lima">Distributed.</span>
        </h1>
        <p className="mt-3 max-w-[52ch] text-sm leading-relaxed text-fog">
          Run inference on a network of GPUs. Open compute. Higher intelligence.
        </p>

        <div className="mt-6">
          <div className="mb-2 flex items-center justify-between font-tech text-base tracking-[0.18em] text-fog">
            <span>YOUR PROMPT</span>
            <span>{prompt.length}/2000</span>
          </div>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value.slice(0, 2000))}
            rows={5}
            className="w-full resize-none border border-line bg-void p-4 font-tech text-lg leading-snug text-white outline-none placeholder:text-fog focus:border-lima"
          />
        </div>

        <div className="mt-5">
          <div className="mb-2 font-tech text-base tracking-[0.18em] text-fog">MODEL (FIXED)</div>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            {MODELS.map((m) => (
              <div
                key={m.id}
                className={`border p-3 text-center ${
                  m.active ? "border-lima" : "border-line opacity-40"
                }`}
              >
                <div className="font-tech text-lg leading-none">{m.id}</div>
                <div className="mt-1 font-tech text-sm text-fog">{m.active ? "ACTIVE" : "SIN FORGE"}</div>
              </div>
            ))}
          </div>
        </div>

        <button
          onClick={onRun}
          disabled={busy}
          className="mt-6 flex w-full items-center justify-center gap-3 bg-lima py-4 text-lg font-bold tracking-wide text-black transition-transform active:translate-y-[1px] disabled:opacity-50"
        >
          <span aria-hidden>▶</span> {busy ? "RUNNING..." : "Run"}
        </button>
        <div className="mt-2 flex justify-between font-tech text-sm text-fog">
          <span>One action. No decisions.</span>
          <span>Hick&apos;s Law</span>
        </div>
      </div>

      {/* derecha: stream + kill */}
      <div className="flex flex-col">
        <div className="flex flex-1 flex-col border border-line bg-panel">
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
            {out || <span className="text-fog">… Esperando RUN. El stream aparece acá, token por token.</span>}
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

        <button
          onClick={onKillToggle}
          className={`mt-4 flex w-full items-center justify-center gap-3 border py-4 text-lg font-bold tracking-wide transition-transform active:translate-y-[1px] ${
            dead ? "border-lima text-lima" : "border-danger text-danger"
          }`}
        >
          <span aria-hidden className={`inline-block h-3 w-3 ${dead ? "bg-lima" : "bg-danger"}`} />
          {dead ? "Revivir Forge" : "Kill Forge"}
        </button>
        <div className="mt-2 flex justify-between font-tech text-sm text-fog">
          <span>{dead ? "Primario muerto: el próximo request hace failover." : "Emergency stop."}</span>
          <span>Fitts&apos;s Law</span>
        </div>
      </div>
    </div>
  );
}
