"use client";

// spec 008 — leaderboard de forges por earnings on-chain (índice Envio).
// Solo lo cobrado de verdad: released - refunded no se computa, el
// indexer ya agrega totalEarnedUsdc por forge desde eventos Released.
import { useEffect, useState } from "react";
import { getLeaderboard, type LeaderboardRow } from "../../lib/weaver";
import { short, txUrl, accountUrl } from "../../lib/site";

const usdc = (raw: string) => `$${(Number(raw) / 1e6).toFixed(2)}`;

export function Leaderboard({ base }: { base: string }) {
  const [rows, setRows] = useState<LeaderboardRow[] | null>(null);
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      const r = await getLeaderboard(base);
      if (!alive) return;
      if (r !== null) setSeen(true);
      setRows(r);
    };
    void poll();
    const id = setInterval(() => void poll(), 15_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [base]);

  if (!seen) return null;

  return (
    <div className="mt-6 border border-line bg-panel">
      <div className="border-b border-line px-4 py-2 font-tech text-sm tracking-[0.2em] text-fog">
        FORGE LEADERBOARD — <span className="text-fog/60">earnings on-chain verificados</span>
      </div>
      {!rows || rows.length === 0 ? (
        <div className="px-4 py-3 font-tech text-lg text-fog">
          Sin forges indexados todavía — el indexer todavía no vio un ForgeRegistered.
        </div>
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((f, i) => (
            <li key={f.worker} className="flex flex-wrap items-center gap-x-4 px-4 py-3 font-tech">
              <span className="w-8 text-xl text-fog">{String(i + 1).padStart(2, "0")}</span>
              <a
                href={accountUrl(f.worker, "evm")}
                target="_blank"
                rel="noreferrer"
                className="text-xl text-white hover:text-lima"
                title={`worker ${f.worker}`}
              >
                {short(f.worker)}
              </a>
              <span className="text-sm tracking-[0.15em] text-fog" title={`signer ${f.signer}`}>
                sig {short(f.signer)}
              </span>
              <span className="ml-auto flex items-baseline gap-5 text-right">
                <span className="text-sm text-fog">
                  {f.completedJobs} jobs{f.refundedJobs > 0 ? ` · ${f.refundedJobs} rf` : ""}
                </span>
                <span className="text-xl text-lima">{usdc(f.earnedUsdc)}</span>
              </span>
              <a
                href={txUrl(f.registeredTx, "evm")}
                target="_blank"
                rel="noreferrer"
                className="text-sm tracking-[0.15em] text-fog hover:text-white"
                title={`registro on-chain @ block ${f.registeredAtBlock}`}
              >
                reg ↗
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
