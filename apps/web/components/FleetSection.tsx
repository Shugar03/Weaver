"use client";

import { useEffect, useState } from "react";
import type { ForgeView } from "../lib/weaver";

function ForgeCard({ forge, selected }: { forge: ForgeView; selected: boolean }) {
  const hot = forge.hot;
  return (
    <div className={`border bg-panel p-5 ${selected ? "border-lima" : "border-line"}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 font-tech text-xl">
          <span className={`inline-block h-2 w-2 rounded-full ${hot ? "bg-lima" : "bg-fog"}`} />
          {forge.forgeId}
        </div>
        <div className="flex gap-2">
          {forge.sim ? (
            <span className="border border-line px-2 py-0.5 font-tech text-sm tracking-[0.15em] text-fog">SIM</span>
          ) : null}
          <span
            className={`px-2 py-0.5 font-tech text-sm tracking-[0.15em] ${
              hot ? "bg-lima text-black" : "bg-line text-fog"
            }`}
          >
            {hot ? "HOT" : "COLD"}
          </span>
        </div>
      </div>
      <div className="mt-1 font-tech text-base text-fog">{forge.model}</div>
      <div className="mt-4 grid grid-cols-3 gap-2 border-t border-line pt-4">
        <div>
          <div className="font-tech text-sm tracking-[0.15em] text-fog">RTT</div>
          <div className="font-tech text-2xl">{forge.rttMs} ms</div>
        </div>
        <div>
          <div className="font-tech text-sm tracking-[0.15em] text-fog">QUEUE</div>
          <div className="font-tech text-2xl">{forge.queueMs}</div>
        </div>
        <div>
          <div className="font-tech text-sm tracking-[0.15em] text-fog">LOAD</div>
          <div className="font-tech text-2xl">{forge.hot ? "0%" : `${Math.min(99, Math.round(forge.loadTimeMs / 200))}%`}</div>
        </div>
      </div>
      <div className="mt-4 border-t border-line pt-4">
        <div className="font-tech text-2xl">
          {forge.price === 0 ? (
            <>FREE <span className="text-base text-fog">/ local</span></>
          ) : (
            <>${forge.price.toFixed(5)} <span className="text-base text-fog">/ 1K tok</span></>
          )}
        </div>
        <div className="mt-2 flex items-center justify-between font-tech text-lg">
          <span>{(forge.reliability * 100).toFixed(1)}%</span>
          <span className="text-sm text-fog">Reliability</span>
        </div>
        <div className="mt-1 h-1 w-full bg-line">
          <div className={`h-1 ${hot ? "bg-lima" : "bg-fog"}`} style={{ width: `${Math.round(forge.reliability * 100)}%` }} />
        </div>
      </div>
    </div>
  );
}

export function FleetSection({ base, initial }: { base: string; initial: ForgeView[] | null }) {
  const [forges, setForges] = useState<ForgeView[] | null>(initial);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    const onForge = (e: Event) => setSelected((e as CustomEvent<string>).detail);
    window.addEventListener("weaver:forge", onForge);
    const id = setInterval(async () => {
      try {
        const r = await fetch(`${base}/v1/forges`, { cache: "no-store" });
        if (r.ok) setForges((await r.json()) as ForgeView[]);
      } catch {
        /* se mantiene lo último conocido */
      }
    }, 5000);
    return () => {
      window.removeEventListener("weaver:forge", onForge);
      clearInterval(id);
    };
  }, [base]);

  if (!forges) {
    return (
      <div className="border border-line bg-panel p-8 font-tech text-xl text-fog">
        <span className="text-danger">■</span> GATEWAY CAÍDO — levantá el gateway para ver la fleet:
        <span className="text-white"> node apps/gateway/src/serve.ts</span>
      </div>
    );
  }
  const shown = forges.slice(0, 4);
  return (
    <div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {shown.map((f) => (
          <ForgeCard key={f.forgeId} forge={f} selected={selected === f.forgeId} />
        ))}
      </div>
      {forges.length > 4 ? (
        <div className="mt-4 font-tech text-lg text-fog">+{forges.length - 4} MORE FORGES</div>
      ) : null}
    </div>
  );
}
