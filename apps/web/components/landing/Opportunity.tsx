import { EXPLORER, short, type Deployment } from "../../lib/site";

// Panel derecho: en vez de foto stock, la red de verdad (contrato + última tx + forges).
export function Opportunity({
  deployment,
  forgeCount,
  hotCount,
}: {
  deployment: Deployment | null;
  forgeCount: number | null;
  hotCount: number;
}) {
  const lastTx = deployment?.txs.release_job_1 ?? deployment?.txs.fund_job_1;
  return (
    <div className="grid grid-cols-1 gap-10 lg:grid-cols-2">
      <div>
        <div className="font-tech text-lg tracking-[0.2em] text-fog">
          <span className="text-lima">{"//"}</span> THE OPPORTUNITY
        </div>
        <h2 className="mt-4 text-4xl leading-[1.02] font-bold tracking-tight md:text-6xl">
          INTELLIGENCE SHOULD NOT BE A PRIVILEGE<span className="text-lima">.</span>
        </h2>
        <p className="mt-5 max-w-[58ch] text-sm leading-relaxed text-fog">
          Weaver unlocks global compute by connecting underutilized resources. A fair, open and efficient
          infrastructure for builders, researchers and everyone pushing the frontier.
        </p>
        <a
          href="https://github.com/Shugar03/Weaver"
          target="_blank"
          rel="noreferrer"
          className="mt-6 inline-block border-b border-lima pb-1 font-tech text-xl tracking-[0.15em] text-white hover:text-lima"
        >
          LEARN MORE →
        </a>
      </div>
      <div className="relative border border-line bg-panel p-6">
        <span className="absolute top-2 left-2 font-tech text-lima">┌</span>
        <span className="absolute top-2 right-2 font-tech text-lima">┐</span>
        <span className="absolute bottom-2 left-2 font-tech text-lima">└</span>
        <span className="absolute right-2 bottom-2 font-tech text-lima">┘</span>
        <div className="font-tech text-base tracking-[0.15em] text-fog">
          A DISTRIBUTED FUTURE
          <br />
          FOR A BRIGHTER TOMORROW
          <br />
          <span className="text-lima">{"//"}</span>
        </div>
        <div className="mt-6 space-y-3 font-tech text-xl">
          <div className="flex items-center justify-between border-b border-line pb-3">
            <span className="text-fog">CONTRACT</span>
            {deployment ? (
              <a href={`${EXPLORER.contract}${deployment.contract_id}`} target="_blank" rel="noreferrer" className="hover:text-lima">
                {short(deployment.contract_id)} ↗
              </a>
            ) : (
              <span className="text-fog">—</span>
            )}
          </div>
          <div className="flex items-center justify-between border-b border-line pb-3">
            <span className="text-fog">LAST PAYOUT</span>
            {deployment && lastTx ? (
              <a href={`${EXPLORER.tx}${lastTx}`} target="_blank" rel="noreferrer" className="text-lima hover:underline">
                {short(lastTx)} ↗
              </a>
            ) : (
              <span className="text-fog">—</span>
            )}
          </div>
          <div className="flex items-center justify-between">
            <span className="text-fog">FORGES</span>
            <span>{forgeCount === null ? "OFFLINE" : `${forgeCount} · ${hotCount} HOT`}</span>
          </div>
        </div>
        <div className="mt-8 text-right font-tech text-lg text-fog">[ W ]</div>
      </div>
    </div>
  );
}
