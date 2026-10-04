"use client";

// spec 008 — strip de contadores del protocolo, indexados por Envio.
// Fuente: /v1/network/stats (tablas envio en pg). Sin indexer → la tira
// no aparece (la página sigue igual); dato ausente → "—", nunca inventado.
import { useEffect, useState } from "react";
import { getNetworkStats, type NetworkStats } from "../../lib/weaver";

const usdc = (raw: string) => {
  const v = Number(raw) / 1e6;
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(2);
};

function Cell({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex flex-col gap-1 border-l border-line pl-4 first:border-l-0 first:pl-0">
      <span className="font-tech text-xs tracking-[0.25em] text-fog">{label}</span>
      <span className={`font-tech text-2xl tracking-tight ${accent ? "text-lima" : "text-white"}`}>{value}</span>
    </div>
  );
}

export function StatsStrip({ base }: { base: string }) {
  const [stats, setStats] = useState<NetworkStats | null>(null);
  const [seen, setSeen] = useState(false); // el endpoint respondió alguna vez

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      const s = await getNetworkStats(base);
      if (!alive) return;
      if (s !== null) setSeen(true);
      setStats(s);
    };
    void poll();
    const id = setInterval(() => void poll(), 15_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [base]);

  // Endpoint 404 (sin indexer) y nunca respondió → no renderizar la tira
  // (honesto: no hay índice, no hay strip — no mostrar zeros falsos).
  if (!seen) return null;

  const s = stats;
  return (
    <div className="mt-6 border border-line bg-panel">
      <div className="flex items-center justify-between border-b border-line px-4 py-2 font-tech text-sm tracking-[0.2em] text-fog">
        <span>PROTOCOLO — INDEXADO POR ENVIO</span>
        {s && (
          <span className="text-fog/70" title="último bloque de Monad procesado por el indexer">
            @ block {s.indexedAtBlock.toLocaleString()}
          </span>
        )}
      </div>
      <div className="grid grid-cols-2 gap-4 px-4 py-4 sm:grid-cols-3 md:grid-cols-6">
        <Cell label="JOBS" value={s ? String(s.funded) : "—"} />
        <Cell label="SETTLED" value={s ? String(s.released) : "—"} accent />
        <Cell label="REFUNDED" value={s ? String(s.refunded) : "—"} />
        <Cell label="VOLUMEN USDC" value={s ? `$${usdc(s.volumeUsdc)}` : "—"} accent />
        <Cell label="DEPOSITADO" value={s ? `$${usdc(s.depositedUsdc)}` : "—"} />
        <Cell label="FEEDBACKS" value={s ? String(s.feedbacks) : "—"} />
      </div>
    </div>
  );
}
