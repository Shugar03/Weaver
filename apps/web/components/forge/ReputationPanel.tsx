"use client";

// spec 010 — panel de reputación ERC-8004 en la consola del forge.
// Cada feedback es una attestation on-chain (NewFeedback del contrato de
// reputación, indexado por envio). Revocados se muestran tachados — el
// registro los conserva, el avg los excluye (lo hace el endpoint).
import { useEffect, useState } from "react";
import { getReputation, type Reputation } from "../../lib/weaver";
import { accountUrl, short, txUrl } from "../../lib/site";

const scoreOf = (value: string, decimals: number) => Number(value) / 10 ** decimals;

export function ReputationPanel({ base, agentId }: { base: string; agentId: number }) {
  const [rep, setRep] = useState<Reputation | null>(null);
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      const r = await getReputation(base, agentId);
      if (!alive) return;
      if (r !== null) setSeen(true);
      setRep(r);
    };
    void poll();
    const id = setInterval(() => void poll(), 15_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [base, agentId]);

  if (!seen) return null;

  return (
    <div className="mt-6 border border-line bg-panel">
      <div className="flex items-center justify-between border-b border-line px-4 py-2 font-tech text-sm tracking-[0.2em] text-fog">
        <span>
          REPUTACIÓN ERC-8004 — <span className="text-white">agent #{agentId}</span>
        </span>
        {rep && (
          <span className="text-lima">
            avg {rep.avgScore ?? "—"} · {rep.count}fb
          </span>
        )}
      </div>
      {!rep || rep.count === 0 ? (
        <div className="px-4 py-3 font-tech text-lg text-fog">
          Sin attestations todavía — la identidad está registrada on-chain, la reputación se gana por job.
        </div>
      ) : (
        <ul className="divide-y divide-line">
          {rep.feedbacks.map((f) => {
            const score = scoreOf(f.value, f.valueDecimals);
            return (
              <li
                key={`${f.txHash}-${f.feedbackIndex}`}
                className={`flex flex-wrap items-center gap-x-4 px-4 py-2.5 font-tech text-lg ${
                  f.revoked ? "opacity-40" : ""
                }`}
              >
                <span className={f.revoked ? "text-fog line-through" : "text-lima"}>
                  {score > 0 ? `+${score}` : score}
                </span>
                <span className="text-white">{f.tag1 || "feedback"}</span>
                {f.tag2 && <span className="text-fog">{f.tag2}</span>}
                <a
                  href={accountUrl(f.clientAddress, "evm")}
                  target="_blank"
                  rel="noreferrer"
                  className="text-fog hover:text-white"
                  title={`cliente ${f.clientAddress}`}
                >
                  {short(f.clientAddress)}
                </a>
                {f.revoked && <span className="border border-danger/40 px-1 text-sm text-danger">REVOKED</span>}
                <span className="ml-auto flex items-center gap-3">
                  <span className="text-sm text-fog" title="bloque">
                    @{Number(f.blockNumber).toLocaleString()}
                  </span>
                  <a
                    href={txUrl(f.txHash, "evm")}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm tracking-[0.15em] text-fog hover:text-white"
                    title={f.txHash}
                  >
                    tx ↗
                  </a>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
