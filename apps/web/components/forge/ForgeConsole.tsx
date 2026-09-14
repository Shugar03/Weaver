"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import type { Deployment } from "../../lib/site";

// Consola del proveedor (supply). Todo número es vivo o declarado:
// gateway (/v1/status, /v1/executions), Ollama /api/ps directo, o deployment commiteado.
// Lo que no medimos (temp, power, geo, 30d) NO se muestra. Punto.
type Exec = { forgeId: string; model: string; ttftMs: number; ok: boolean; ts: number };
type Status = { version: string; uptimeMs: number } | null;
type PsModel = { name?: string; size?: number; size_vram?: number; expires_at?: string };

const EXPLORER_TX = "https://stellar.expert/explorer/testnet/tx/";
const EXPLORER_ACCOUNT = "https://stellar.expert/explorer/testnet/account/";

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `hace ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `hace ${h}h`;
  return `hace ${Math.floor(h / 24)}d`;
}

function uptime(ms: number): string {
  const m = Math.floor(ms / 60000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d > 0) return `${d}d ${h}h ${m % 60}m`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
}

function gb(bytes?: number): string {
  if (!bytes) return "—";
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

function short(h: string) {
  return h.length > 12 ? `${h.slice(0, 4)}...${h.slice(-4)}` : h;
}

function Spark({ values }: { values: number[] }) {
  if (values.length < 2) return <div className="font-tech text-lg text-fog">sin historial todavía</div>;
  const max = Math.max(...values, 1);
  const pts = values
    .slice(-24)
    .map((v, i, a) => `${(i / Math.max(1, a.length - 1)) * 100},${28 - Math.min(1, v / max) * 24}`)
    .join(" ");
  return (
    <svg viewBox="0 0 100 30" className="h-10 w-full" preserveAspectRatio="none" aria-hidden>
      <polyline points={pts} fill="none" stroke="#d0ff00" strokeWidth="1.5" />
    </svg>
  );
}

export function ForgeConsole({
  base,
  ollama,
  deployment,
}: {
  base: string;
  ollama: string;
  deployment: Deployment | null;
}) {
  const [status, setStatus] = useState<Status>(null);
  const [bootAt, setBootAt] = useState<number | null>(null);
  const [execs, setExecs] = useState<Exec[] | null>(null);
  const [ps, setPs] = useState<PsModel[] | null>(null);
  const [now, setNow] = useState(Date.now());
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const [s, e] = await Promise.all([
          fetch(`${base}/v1/status`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
          fetch(`${base}/v1/executions?limit=12`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
        ]);
        if (alive) {
          if (s) {
            const st = s as Status;
            setStatus(st);
            if (st) setBootAt(Date.now() - st.uptimeMs);
          }
          if (e) setExecs(e as Exec[]);
        }
      } catch {
        /* gateway caído: se mantiene lo último */
      }
      try {
        const p = await fetch(`${ollama}/api/ps`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null));
        if (alive && p) setPs((p.models ?? []) as PsModel[]);
      } catch {
        /* ollama caído */
      }
    };
    poll();
    const id = setInterval(poll, 5000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      alive = false;
      clearInterval(id);
      clearInterval(tick);
    };
  }, [base, ollama]);

  const online = status !== null;
  const ttfts = (execs ?? []).filter((e) => e.ok).map((e) => e.ttftMs);
  const p50 = ttfts.length > 0 ? [...ttfts].sort((a, b) => a - b)[Math.floor((ttfts.length - 1) / 2)] : null;
  const last = execs?.[0] ?? null;
  const loaded = ps?.[0];
  const releaseTx = deployment?.txs.release_job_1;
  void now;

  async function copyId() {
    try {
      await navigator.clipboard.writeText("ollama-local");
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* nada */
    }
  }

  return (
    <div className="flex min-h-dvh bg-void text-white">
      {/* SIDEBAR */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-line bg-panel lg:flex">
        <a href="/" className="flex items-center gap-2.5 p-4">
          <Image src="/weaver-mark.png" alt="Weaver" width={26} height={26} />
          <span className="text-base font-bold tracking-[0.3em]">WEAVER</span>
        </a>
        <nav className="space-y-0.5 px-3 font-tech text-lg">
          <a href="/dashboard" className="block px-3 py-2 text-fog hover:text-white">
            Dashboard
          </a>
          <div className="border border-line bg-void px-3 py-2 text-lima">▣ My Forge</div>
          <a href="#jobs" className="block px-3 py-2 text-fog hover:text-white">
            Jobs
          </a>
          <a href="#earnings" className="block px-3 py-2 text-fog hover:text-white">
            Earnings
          </a>
          <a href="/dashboard" className="block px-3 py-2 text-fog hover:text-white">
            Network
          </a>
          <a href="/chat" className="block px-3 py-2 text-fog hover:text-white">
            Chat
          </a>
          <div className="px-3 py-2 text-fog/60">
            Hardware <span className="border border-line px-1 text-sm">SOON</span>
          </div>
          <div className="px-3 py-2 text-fog/60">
            Settings <span className="border border-line px-1 text-sm">SOON</span>
          </div>
        </nav>
        <div className="mt-auto space-y-3 p-3">
          <div className="border border-line p-4">
            <div className="text-sm font-bold">Keep the network alive.</div>
            <div className="mt-1 font-tech text-base text-fog">
              Share compute.
              <br />
              Power a more open future.
            </div>
            <div className="mt-3 font-tech text-2xl text-lima">[ W ]</div>
            <a href="/#opportunity" className="mt-2 block font-tech text-base text-lima hover:underline">
              Read the manifesto →
            </a>
          </div>
          <div className="flex items-center gap-2.5 border border-line px-3 py-2.5">
            <span className="flex h-8 w-8 items-center justify-center border border-lima font-tech text-lg text-lima">S</span>
            <div>
              <div className="text-sm font-bold">Sebastian</div>
              <div className="font-tech text-sm text-fog">Operator</div>
            </div>
          </div>
        </div>
      </aside>

      {/* MAIN */}
      <div className="min-w-0 flex-1 px-4 py-6 md:px-8">
        <div className="flex items-center justify-between font-tech text-base tracking-[0.15em] text-fog">
          <span>
            Forge <span className="text-fog/50">/</span> <span className="text-white">ollama-local</span>
          </span>
          <span className="hidden items-center gap-4 md:flex">
            <span>LOCAL NODE</span>
            <span>v{status?.version ?? "…"}</span>
            <span className={online ? "text-lima" : "text-danger"}>● {online ? "Online" : "Offline"}</span>
          </span>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-4">
          <h1 className="text-4xl font-bold tracking-tight md:text-5xl">ollama-local</h1>
          <span className={`border px-2.5 py-1 font-tech text-base tracking-[0.15em] ${online ? "border-lima text-lima" : "border-danger text-danger"}`}>
            {online ? "● ONLINE" : "■ OFFLINE"}
          </span>
          <a
            href="https://github.com/Shugar03/Weaver/blob/main/apps/gateway/src/serve.ts"
            target="_blank"
            rel="noreferrer"
            className="ml-auto border border-line px-4 py-2 font-tech text-lg text-fog hover:border-lima hover:text-white"
          >
            Edit Forge
          </a>
        </div>
        <p className="mt-1 text-sm text-fog">Contributing compute to a more open internet.</p>

        {/* META CARDS */}
        <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          {[
            ["NODE", "LOCAL · M5 Air"],
            ["UPTIME", bootAt === null ? "—" : uptime(now - bootAt)],
            ["MODEL", "qwen3:4b"],
            ["STATUS", online ? "● Accepting jobs" : "■ Gateway down"],
            ["VERSION", status ? `v${status.version}` : "—"],
          ].map(([k, v]) => (
            <div key={k} className="border border-line bg-panel p-4">
              <div className="font-tech text-sm tracking-[0.2em] text-fog">{k}</div>
              <div className="mt-1 font-tech text-2xl leading-tight">{v}</div>
            </div>
          ))}
          <div className="border border-line bg-panel p-4">
            <div className="font-tech text-sm tracking-[0.2em] text-fog">FORGE ID</div>
            <button onClick={copyId} className="mt-1 font-tech text-2xl leading-tight hover:text-lima" title="Copiar">
              ollama-local {copied ? "✓" : "⧉"}
            </button>
          </div>
        </div>

        {/* COMPUTE */}
        <div className="mt-6 border border-line bg-panel p-5">
          <div className="flex items-center justify-between">
            <span className="text-lg font-bold">Compute status</span>
            <span className="font-tech text-base text-fog">
              <span className={online ? "text-lima" : "text-fog"}>●</span> {online ? "Live" : "stale"} · desde el boot
            </span>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div className="border border-line p-4">
              <div className="font-tech text-sm tracking-[0.2em] text-fog">MODEL VRAM</div>
              <div className="mt-1 font-tech text-3xl">{gb(loaded?.size_vram ?? loaded?.size)}</div>
              <div className="mt-1 font-tech text-base text-fog">{loaded ? `${loaded.name} · Metal` : "modelo sin cargar"}</div>
            </div>
            <div className="border border-line p-4">
              <div className="font-tech text-sm tracking-[0.2em] text-fog">EXECUTIONS</div>
              <div className="mt-1 font-tech text-3xl">{execs === null ? "—" : execs.length}</div>
              <div className="mt-1 font-tech text-base text-fog">esta sesión del nodo</div>
            </div>
            <div className="border border-line p-4">
              <div className="font-tech text-sm tracking-[0.2em] text-fog">P50 TTFT</div>
              <div className="mt-1 font-tech text-3xl">{p50 === null ? "—" : `${p50.toLocaleString()} ms`}</div>
              <div className="mt-1 font-tech text-base text-fog">medido sirviendo</div>
            </div>
            <div className="border border-line p-4">
              <div className="font-tech text-sm tracking-[0.2em] text-fog">TTFT HISTORY</div>
              <div className="mt-2">
                <Spark values={ttfts} />
              </div>
            </div>
          </div>
        </div>

        <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-5">
          {/* JOBS */}
          <div id="jobs" className="scroll-mt-20 border border-line bg-panel p-5 xl:col-span-3">
            <div className="font-tech text-lg tracking-[0.2em] text-fog">LAST EXECUTION · <span className="text-fog/60">since boot</span></div>
            {last ? (
              <div className="mt-3 border border-line p-4">
                <div className="flex items-center justify-between">
                  <span className="font-tech text-2xl">{last.model}</span>
                  <span className={`font-tech text-lg ${last.ok ? "text-lima" : "text-danger"}`}>● {last.ok ? "Completed" : "Failed"}</span>
                </div>
                <div className="mt-2 grid grid-cols-3 gap-2 font-tech text-lg">
                  <div><span className="text-fog">FORGE </span>{last.forgeId}</div>
                  <div><span className="text-fog">TTFT </span>{last.ttftMs} ms</div>
                  <div><span className="text-fog">WHEN </span>{ago(last.ts)}</div>
                </div>
              </div>
            ) : (
              <div className="mt-3 border border-line p-4 font-tech text-lg text-fog">
                {execs === null ? "Gateway caído — levantá :3101." : "Sin ejecuciones todavía — corré algo en /chat."}
              </div>
            )}
            <div className="mt-4 font-tech text-lg tracking-[0.2em] text-fog">RECENT</div>
            <ul className="mt-2 divide-y divide-line">
              {(execs ?? []).slice(0, 8).map((e, i) => (
                <li key={`${e.ts}-${i}`} className="flex items-center justify-between py-2 font-tech text-lg">
                  <span>{e.model} <span className="text-fog">· {ago(e.ts)}</span></span>
                  <span className={e.ok ? "text-lima" : "text-danger"}>
                    {e.ok ? `Completed · ${e.ttftMs} ms` : "Failed"}
                  </span>
                </li>
              ))}
              {(execs ?? []).length === 0 && <li className="py-2 font-tech text-lg text-fog">—</li>}
            </ul>
          </div>

          {/* EARNINGS */}
          <div id="earnings" className="scroll-mt-20 border border-line bg-panel p-5 xl:col-span-2">
            <div className="font-tech text-lg tracking-[0.2em] text-fog">EARNINGS · <span className="text-lima">TESTNET</span></div>
            <div className="mt-2 font-tech text-6xl">$0.01</div>
            <div className="font-tech text-base text-fog">Total · 1 payout · USDC de juguete</div>
            {releaseTx && deployment ? (
              <a
                href={`${EXPLORER_TX}${releaseTx}`}
                target="_blank"
                rel="noreferrer"
                className="mt-4 flex items-center justify-between border border-line px-4 py-3 hover:border-lima"
              >
                <span className="font-tech text-xl">Release #1</span>
                <span className="font-tech text-lg text-lima">{short(releaseTx)} ↗</span>
              </a>
            ) : null}
            <div className="mt-4 font-tech text-base leading-snug text-fog">
              Sin gráficos de 30 días: con 1 payout, una barra solitaria mentiría más que esta cifra pelada.
              Mainnet y retiros vienen después del hackathon.
            </div>
            {deployment?.worker && (
              <a
                href={`${EXPLORER_ACCOUNT}${deployment.worker}`}
                target="_blank"
                rel="noreferrer"
                className="mt-3 block font-tech text-lg text-fog hover:text-lima"
              >
                worker {short(deployment.worker)} ↗
              </a>
            )}
          </div>
        </div>

        <footer className="mt-10 flex flex-col gap-2 border-t border-line py-5 font-tech text-base tracking-[0.15em] text-fog md:flex-row md:justify-between">
          <span><span className="font-bold tracking-[0.3em] text-white">WEAVER</span> · OPEN COMPUTE. HIGHER INTELLIGENCE.</span>
          <span>supply console · datos vivos o nada</span>
        </footer>
      </div>
    </div>
  );
}
