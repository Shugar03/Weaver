"use client";

// 04 SETTLE — feed de liquidaciones reales desde /v1/executions.
// Solo muestra ejecuciones con settle != null; si el gateway no liquida
// (modo dev), lo dice en vez de inventar números.
import { useEffect, useState } from "react";
import { EXPLORER, short } from "../../lib/site";

type Exec = {
  forgeId: string;
  model: string;
  ts: number;
  settle?: { fundTx?: string; releaseTx?: string; status: "pending" | "settled" | "failed" };
};

export function SettleFeed({ base }: { base: string }) {
  const [execs, setExecs] = useState<Exec[] | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const r = await fetch(`${base}/v1/executions?limit=50`, { cache: "no-store" });
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

  const withSettle = (execs ?? []).filter((e) => e.settle);

  return (
    <div className="mt-4 border border-line bg-panel">
      <div className="border-b border-line px-4 py-2 font-tech text-base tracking-[0.2em] text-fog">
        SETTLEMENTS RECIENTES — <span className="text-fog/60">desde telemetría, no del deploy</span>
      </div>
      {execs === null ? (
        <div className="px-4 py-3 font-tech text-lg text-fog">gateway caído</div>
      ) : withSettle.length === 0 ? (
        <div className="px-4 py-3 font-tech text-lg text-fog">
          Sin settles todavía — las ejecuciones del chat demo no liquidan individualmente. Los payouts del deploy están arriba.
        </div>
      ) : (
        <ul className="divide-y divide-line">
          {withSettle.map((e, i) => (
            <li key={`${e.ts}-${i}`} className="flex flex-wrap items-center gap-x-4 px-4 py-2.5 font-tech text-lg">
              <span className={e.settle!.status === "settled" ? "text-lima" : e.settle!.status === "failed" ? "text-danger" : "text-fog"}>
                {e.settle!.status === "settled" ? "● settled" : e.settle!.status === "failed" ? "■ failed" : "◐ pending"}
              </span>
              <span>{e.forgeId}</span>
              <span className="text-fog">{e.model}</span>
              <span className="ml-auto flex gap-3">
                {e.settle!.fundTx && (
                  <a href={`${EXPLORER.tx}${e.settle!.fundTx}`} target="_blank" rel="noreferrer" className="text-fog hover:text-lima">
                    fund {short(e.settle!.fundTx)} ↗
                  </a>
                )}
                {e.settle!.releaseTx && (
                  <a href={`${EXPLORER.tx}${e.settle!.releaseTx}`} target="_blank" rel="noreferrer" className="text-lima hover:underline">
                    release {short(e.settle!.releaseTx)} ↗
                  </a>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
