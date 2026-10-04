"use client";

// spec 010 — chip de reputación ERC-8004 por forge.
// Solo se monta cuando el agentId está VERIFICADO on-chain (ownerOf == forge);
// un claim sin verificar no es evidencia. Datos del índice envio — si el
// endpoint no existe, el chip no aparece (jamás "0" fabricado).
import { useEffect, useState } from "react";
import { getReputation } from "../../lib/weaver";

export function RepChip({ base, agentId }: { base: string; agentId: number }) {
  const [rep, setRep] = useState<{ avgScore: number | null; count: number } | null>(null);
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      const r = await getReputation(base, agentId);
      if (!alive) return;
      if (r !== null) setSeen(true);
      if (r) setRep({ avgScore: r.avgScore, count: r.count });
    };
    void poll();
    const id = setInterval(() => void poll(), 15_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [base, agentId]);

  if (!seen) return null;

  const has = rep !== null && rep.count > 0;
  return (
    <span
      className={`border px-1.5 py-0.5 font-tech text-sm tracking-[0.1em] ${
        has ? "border-lima/40 text-lima" : "border-line text-fog"
      }`}
      title={`agente ERC-8004 #${agentId} — ${rep?.count ?? 0} attestations on-chain${
        rep?.avgScore !== null && rep?.avgScore !== undefined ? ` · avg ${rep.avgScore}` : ""
      }`}
    >
      REP {rep?.avgScore ?? "—"} · {rep?.count ?? 0}fb
    </span>
  );
}
