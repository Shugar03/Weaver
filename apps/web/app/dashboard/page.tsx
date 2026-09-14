import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { FleetSection } from "../../components/FleetSection";
import { ProofSection } from "../../components/ProofSection";
import { RunPanel } from "../../components/RunPanel";
import { SectionHead } from "../../components/SectionHead";
import { SiteHeader } from "../../components/SiteHeader";
import { TrendsSection } from "../../components/TrendsSection";
import { getForges, type ForgeView } from "../../lib/weaver";

const GATEWAY = process.env.WEAVER_GATEWAY ?? "http://localhost:3001";
const EXPLORER_TX = "https://stellar.expert/explorer/testnet/tx/";

type Deployment = {
  contract_id: string;
  admin: string;
  worker?: string;
  token_usdc_sac: string;
  txs: Record<string, string>;
} | null;

type Bench = { stamp: number; n: number; summaries: { name: string; ok: number; p50ttft: number; maxtotal: number }[] } | null;

async function readDeployment(): Promise<Deployment> {
  try {
    const p = join(process.cwd(), "..", "..", "contracts", "weaver-escrow", "deployments", "testnet.json");
    return JSON.parse(await readFile(p, "utf8")) as Deployment;
  } catch {
    return null;
  }
}

async function readBench(): Promise<Bench> {
  try {
    const dir = join(process.cwd(), "..", "..", "packages", "benchmarks", "results");
    const files = (await readdir(dir)).filter((f) => f.startsWith("bench-") && f.endsWith(".json")).sort();
    if (files.length === 0) return null;
    const json = JSON.parse(await readFile(join(dir, files[files.length - 1]), "utf8")) as {
      prompts: string[];
      summaries: Bench extends null ? never : NonNullable<Bench>["summaries"];
    };
    const stamp = Number(files[files.length - 1].replace("bench-", "").replace(".json", ""));
    return { stamp, n: json.prompts.length, summaries: json.summaries };
  } catch {
    return null;
  }
}

function short(h: string) {
  return h.length > 12 ? `${h.slice(0, 4)}...${h.slice(-4)}` : h;
}

export default async function Page() {
  const [forges, deployment, bench]: [ForgeView[] | null, Deployment, Bench] = await Promise.all([
    getForges(GATEWAY),
    readDeployment(),
    readBench(),
  ]);
  const releaseTx = deployment?.txs.release_job_1;
  const lastTx = releaseTx ? { label: `release ${short(releaseTx)}`, url: `${EXPLORER_TX}${releaseTx}` } : null;

  return (
    <>
      <SiteHeader
        logoHref="/"
        links={[
          { label: "Compute", href: "#live" },
          { label: "Network", href: "#fleet" },
          { label: "Docs", href: "#proof" },
          { label: "Trends", href: "#trends" },
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
      <section id="live" className="scroll-mt-20 pt-10">
        <SectionHead index="01" label="LIVE REQUEST" right="REAL AI. DISTRIBUTED." />
        <RunPanel base={GATEWAY} lastTx={lastTx} />
      </section>

      <section id="fleet" className="scroll-mt-20 pt-14">
        <SectionHead index="02" label="FLEET" right={forges ? `${forges.length} FORGES` : "GATEWAY CAÍDO"} />
        <p className="-mt-3 mb-6 text-sm text-fog">Global forges. Real GPUs. SIM = simulated standby for routing demo.</p>
        <FleetSection base={GATEWAY} initial={forges} />
      </section>

      <section id="proof" className="scroll-mt-20 pt-14">
        <SectionHead
          index="03"
          label="PROOF (STELLAR)"
          right={deployment ? "EVERY REQUEST IS VERIFIABLE" : "SIN DEPLOY"}
        />
        <ProofSection deployment={deployment} />
      </section>

      <section id="trends" className="scroll-mt-20 pt-14">
        <SectionHead index="04" label="TRENDS" right="LOWER LATENCY. MORE INTELLIGENCE." />
        <TrendsSection bench={bench} />
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
