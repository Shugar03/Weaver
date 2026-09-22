"use client";

// S26 — fleet como status-page: una fila por forge, solo lo medido.
// Nada de LOAD% fabricado ni reliability declarada: la métrica por fila sale
// de forgeRow() (telemetría real) y los jobs de /v1/executions.
// La fila que sirve un request flashea lima (evento weaver:forge del Pipeline)
// y el kill granular por forge vive acá (operator key, mismo flow del panel).
import { useCallback, useEffect, useRef, useState } from "react";
import { forgeRow, type ExecSample } from "../lib/fleet";
import { setKill, type ForgeView } from "../lib/weaver";

function StatusDot({ status }: { status: "hot" | "cold" | "dead" }) {
  const cls = status === "hot" ? "bg-lima" : status === "cold" ? "bg-fog" : "bg-danger";
  return <span className={`inline-block h-2 w-2 rounded-full ${cls}`} />;
}

function StatusBadge({ status, sim, busy, remote, verified }: { status: "hot" | "cold" | "dead"; sim: boolean; busy: boolean; remote: boolean; verified: boolean }) {
  return (
    <span className="flex gap-2">
      {sim && <span className="border border-line px-2 py-0.5 font-tech text-sm tracking-[0.15em] text-fog">SIM</span>}
      {/* S30/S35: forge remoto por WS — RMT; VERIFIED = attestation pasada
          (ejecutó un job real y firmó con su key registrada). */}
      {remote && (
        <span className={`border px-2 py-0.5 font-tech text-sm tracking-[0.15em] ${verified ? "border-lima/60 text-lima" : "border-line text-fog"}`}>
          {verified ? "RMT ✓" : "RMT"}
        </span>
      )}
      {/* S29: BUSY = saturado medido (inFlight ≥ cap) — distinto de DEAD:
          existe y sirve, pero no toma jobs ahora (429 si todos así). */}
      {busy && <span className="border border-danger/60 px-2 py-0.5 font-tech text-sm tracking-[0.15em] text-danger">BUSY</span>}
      <span
        className={`px-2 py-0.5 font-tech text-sm tracking-[0.15em] ${
          status === "hot" ? "bg-lima text-black" : status === "dead" ? "bg-danger/20 text-danger" : "bg-line text-fog"
        }`}
      >
        {status.toUpperCase()}
      </span>
    </span>
  );
}

export function FleetSection({ base, initial }: { base: string; initial: ForgeView[] | null }) {
  const [forges, setForges] = useState<ForgeView[] | null>(initial);
  const [execs, setExecs] = useState<ExecSample[]>([]);
  const [flash, setFlash] = useState<string | null>(null);
  const [killing, setKilling] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const poll = useCallback(async () => {
    try {
      const [f, e] = await Promise.all([
        fetch(`${base}/v1/forges`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
        fetch(`${base}/v1/executions?limit=50`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
      ]);
      if (f) setForges(f as ForgeView[]);
      if (e) setExecs(e as ExecSample[]);
    } catch {
      /* gateway caído: se mantiene lo último conocido */
    }
  }, [base]);

  useEffect(() => {
    const onForge = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      setFlash(id);
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlash(null), 2500);
    };
    window.addEventListener("weaver:forge", onForge);
    void poll();
    const id = setInterval(() => void poll(), 5000);
    return () => {
      window.removeEventListener("weaver:forge", onForge);
      clearInterval(id);
      if (flashTimer.current) clearTimeout(flashTimer.current);
    };
  }, [poll]);

  async function kill(forgeId: string, dead: boolean) {
    setKilling(forgeId);
    try {
      await setKill(base, dead, forgeId);
    } catch {
      const key = window.prompt("Operator key (la imprime el gateway al arrancar):");
      if (key) {
        const { saveOperatorKey } = await import("../lib/weaver");
        saveOperatorKey(key.trim());
        try {
          await setKill(base, dead, forgeId);
        } catch {
          /* key inválida o gateway caído */
        }
      }
    }
    setKilling(null);
    void poll(); // estado real al toque, sin esperar el intervalo
  }

  if (!forges) {
    return (
      <div className="border border-line bg-panel p-8 font-tech text-xl text-fog">
        <span className="text-danger">■</span> GATEWAY CAÍDO — levantá el gateway para ver la fleet:
        <span className="text-white"> node apps/gateway/src/serve.ts</span>
      </div>
    );
  }

  return (
    <div className="border border-line bg-panel">
      {/* header de tabla — convención status-page */}
      <div className="grid grid-cols-[auto_1fr_auto_auto_auto_auto_auto] items-center gap-x-5 border-b border-line px-4 py-2 font-tech text-sm tracking-[0.2em] text-fog">
        <span />
        <span>FORGE</span>
        <span>MODEL</span>
        <span>MODALIDAD</span>
        <span className="text-right">MEDIDO</span>
        <span className="text-right">JOBS*</span>
        <span />
      </div>
      <ul>
        {forges.map((f) => {
          const r = forgeRow(f, execs);
          const dead = r.status === "dead";
          return (
            <li
              key={f.forgeId}
              className={`grid grid-cols-[auto_1fr_auto_auto_auto_auto_auto] items-center gap-x-5 border-b border-line/60 px-4 py-3 transition-colors last:border-b-0 ${
                flash === f.forgeId ? "bg-lima/10" : ""
              }`}
            >
              <StatusDot status={r.status} />
              <a href={r.href} className="font-tech text-xl hover:text-lima">
                {f.forgeId}
              </a>
              <span className="font-tech text-base text-fog">{f.model}</span>
              <span className="font-tech text-sm tracking-[0.15em] text-fog">{f.capability === "image" ? "IMAGE" : "TEXT"}</span>
              <span className="flex items-center justify-end gap-3">
                <span className="font-tech text-xl">{r.metric}</span>
                <StatusBadge status={r.status} sim={r.sim} busy={r.busy} remote={r.remote} verified={r.verified} />
              </span>
              <span className="text-right font-tech text-lg text-fog">{r.jobs}</span>
              <button
                onClick={() => void kill(f.forgeId, !dead)}
                disabled={killing === f.forgeId}
                title={dead ? "Revivir forge" : "Matar forge (chaos drill)"}
                className={`font-tech text-base tracking-[0.1em] ${
                  dead ? "text-lima hover:text-white" : "text-fog hover:text-danger"
                } disabled:opacity-40`}
              >
                {killing === f.forgeId ? "…" : dead ? "REVIVE" : "KILL"}
              </button>
            </li>
          );
        })}
      </ul>
      <div className="px-4 py-2 font-tech text-sm text-fog">
        *jobs registrados desde el boot del gateway — todo lo que se ve acá es medido.
      </div>
    </div>
  );
}
