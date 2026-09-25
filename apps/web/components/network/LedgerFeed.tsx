"use client";

// 05 LEDGER — feed público de ejecuciones recientes desde /v1/executions.
// Regla de privacidad (decidida, no improvisada):
//   · model + forge + medidas + settle → PÚBLICO: es la promesa de la red
//     (auditable, medido, verificable — la cadena ya lo muestra en explorer).
//   · keyId → ENMASCARADO: es seudónimo pero enumerable; mostrarlo crudo
//     permitiría correlacionar el gasto de una cuenta. Se muestra solo si
//     el request venía con key (●) o fue anónimo/dev (○) — la relación
//     key↔cuenta queda privada en /v1/me/billing del dueño.
//   · prompts → JAMÁS: ni siquiera existen en el sample (viven en RAM).
import { useEffect, useState } from "react";

type Exec = {
  forgeId: string;
  model: string;
  ttftMs: number;
  ok: boolean;
  ts: number;
  keyId?: string;
  genTokens?: number;
  decodeMs?: number;
  settle?: { fundTx?: string; releaseTx?: string; status: "pending" | "settled" | "failed" };
};

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

export function LedgerFeed({ base }: { base: string }) {
  const [execs, setExecs] = useState<Exec[] | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const r = await fetch(`${base}/v1/executions?limit=30`, { cache: "no-store" });
        if (alive && r.ok) setExecs((await r.json()) as Exec[]);
      } catch {
        /* gateway caído */
      }
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [base]);

  return (
    <div className="mt-4 border border-line bg-panel">
      <div className="flex items-baseline justify-between border-b border-line px-4 py-2">
        <span className="font-tech text-base tracking-[0.2em] text-fog">
          NETWORK LEDGER — <span className="text-fog/60">todos los jobs, en vivo</span>
        </span>
        <span className="font-tech text-sm tracking-[0.15em] text-fog/60">
          público: ruta + medidas · privado: prompt + cuenta
        </span>
      </div>
      {execs === null ? (
        <div className="px-4 py-3 font-tech text-lg text-fog">gateway caído</div>
      ) : execs.length === 0 ? (
        <div className="px-4 py-3 font-tech text-lg text-fog">
          Sin ejecuciones todavía — corré algo en /chat o /network#fire y aparece acá.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full font-tech text-base">
            <thead>
              <tr className="border-b border-line text-left text-sm tracking-[0.15em] text-fog/60">
                <th className="px-4 py-2 font-normal">age</th>
                <th className="px-4 py-2 font-normal">model</th>
                <th className="px-4 py-2 font-normal">forge</th>
                <th className="px-4 py-2 font-normal text-right">ttft</th>
                <th className="px-4 py-2 font-normal text-right">tokens</th>
                <th className="px-4 py-2 font-normal">status</th>
                <th className="px-4 py-2 font-normal">settle</th>
                <th className="px-4 py-2 font-normal text-right">key</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {execs.map((e, i) => (
                <tr key={`${e.ts}-${i}`} className="text-fog">
                  <td className="px-4 py-2 text-fog/60">{ago(e.ts)}</td>
                  <td className="px-4 py-2 text-white">{e.model}</td>
                  <td className="px-4 py-2 text-lima">{e.forgeId}</td>
                  <td className="px-4 py-2 text-right">{(e.ttftMs / 1000).toFixed(2)}s</td>
                  <td className="px-4 py-2 text-right">{e.genTokens ?? "—"}</td>
                  <td className="px-4 py-2">
                    {e.ok ? <span className="text-lima">ok</span> : <span className="text-danger">fail</span>}
                  </td>
                  <td className="px-4 py-2">
                    {e.settle?.status === "settled" ? (
                      <span className="text-lima">●</span>
                    ) : e.settle?.status === "failed" ? (
                      <span className="text-danger">■</span>
                    ) : e.settle ? (
                      <span className="text-fog">◐</span>
                    ) : (
                      <span className="text-fog/40">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {e.keyId ? <span title="request con key de cuenta (id oculto)">● wvr</span> : <span className="text-fog/40">○ anon</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
