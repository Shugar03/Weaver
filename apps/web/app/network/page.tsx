import { Pipeline } from "../../components/network/Pipeline";
import { SettleFeed } from "../../components/network/SettleFeed";
import { ProofSection } from "../../components/ProofSection";
import { SectionHead } from "../../components/SectionHead";
import { SiteHeader } from "../../components/SiteHeader";
import { getForges, type ForgeView } from "../../lib/weaver";
import { EXPLORER, short, type Deployment } from "../../lib/site";
import { readDeployment } from "../../lib/deployment";

const GATEWAY = process.env.WEAVER_GATEWAY ?? "http://localhost:3001";

// /network — la red funcionando end-to-end: FIRE → ROUTE → EXECUTE → SETTLE.
// No es un dashboard de métricas: es la prueba viva de que un prompt entra,
// un forge lo sirve, y el escrow lo liquida. Ops por forge: /forge.
export default async function NetworkPage() {
  const [forges, deployment]: [ForgeView[] | null, Deployment | null] = await Promise.all([
    getForges(GATEWAY),
    readDeployment(),
  ]);
  const releaseTx = deployment?.txs.release_job_1;
  const lastTx = releaseTx ? { label: `release ${short(releaseTx)}`, url: `${EXPLORER.tx}${releaseTx}` } : null;

  return (
    <>
      <SiteHeader
        logoHref="/"
        links={[
          { label: "Fire", href: "#fire" },
          { label: "Route", href: "#route" },
          { label: "Execute", href: "#execute" },
          { label: "Settle", href: "#settle" },
          { label: "Forges", href: "/forge" },
          { label: "Chat", href: "/chat" },
        ]}
        right={
          <div className="flex items-center gap-2 border border-line px-3 py-1.5 font-tech text-base tracking-[0.15em]">
            <span className="inline-block h-2 w-2 rounded-full bg-lima" />
            <span className="text-fog">STELLAR TESTNET</span>
          </div>
        }
      />
      <div className="mx-auto max-w-7xl px-4 md:px-6">
        <div className="pb-8">
          <div className="pt-10">
            <h1 className="text-4xl leading-[1.05] font-bold tracking-tight md:text-5xl">
              The network,
              <br />
              <span className="text-lima">working.</span>
            </h1>
            <p className="mt-3 max-w-[58ch] text-sm leading-relaxed text-fog">
              Un request real recorriendo la red: se dispara, la fleet lo rutea, el forge lo ejecuta en stream, y el escrow lo liquida en Stellar.
              Todo medido — nada declarado.
            </p>
          </div>

          <Pipeline base={GATEWAY} initialForges={forges} lastTx={lastTx} />

          {/* 04 — SETTLE */}
          <section id="settle" className="scroll-mt-20 pt-14">
            <SectionHead
              index="04"
              label="SETTLE"
              right={deployment ? "EVERY REQUEST IS VERIFIABLE" : "SIN DEPLOY"}
            />
            <ProofSection deployment={deployment} />
            <SettleFeed base={GATEWAY} />
          </section>
        </div>
      </div>
      <footer className="mt-16 border-t border-line">
        <div className="mx-auto flex max-w-7xl flex-col gap-2 px-4 py-6 font-tech text-base tracking-[0.15em] text-fog md:flex-row md:items-center md:justify-between md:px-6">
          <span className="font-bold tracking-[0.3em] text-white">WEAVER</span>
          <span>OPEN COMPUTE. HIGHER INTELLIGENCE.</span>
          <span>HYBRID: LIVE GATEWAY + REAL TESTNET</span>
        </div>
      </footer>
    </>
  );
}
