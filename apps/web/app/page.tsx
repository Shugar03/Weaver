import Image from "next/image";
import { SiteHeader } from "../components/SiteHeader";
import { HeroBackground } from "../components/landing/HeroBackground";
import { Opportunity } from "../components/landing/Opportunity";
import { Pillars } from "../components/landing/Pillars";
import { Trusted } from "../components/landing/Trusted";
import { getForges } from "../lib/weaver";
import { readDeployment } from "../lib/site";

const GATEWAY = process.env.WEAVER_GATEWAY ?? "http://localhost:3001";

export default async function Landing() {
  const [forges, deployment] = await Promise.all([getForges(GATEWAY), readDeployment()]);
  const hot = forges?.filter((f) => f.hot).length ?? 0;

  return (
    <>
      <SiteHeader
        logoHref="/"
        links={[
          { label: "PRODUCT", href: "#pillars" },
          { label: "TECHNOLOGY", href: "/dashboard" },
          { label: "DOCS", href: "https://github.com/Shugar03/Weaver" },
        ]}
        cta={{ label: "GET EARLY ACCESS →", href: "/dashboard" }}
      />
      <main className="mx-auto max-w-7xl px-4 md:px-6">
        {/* HERO: arco + texto + logo integrados */}
        <section className="relative mt-8 flex min-h-[88svh] flex-col overflow-hidden border border-line">
          <HeroBackground />
          <div className="pointer-events-none relative z-10 grid flex-1 grid-cols-1 content-center gap-10 p-6 pb-24 md:p-10 md:pb-28 lg:grid-cols-2">
            <div>
              <div className="font-tech text-lg tracking-[0.2em] text-fog">
                <span className="text-lima">{"//"}</span> WEAVER
              </div>
              <h1 className="mt-4 text-6xl leading-[1.02] font-bold tracking-tight md:text-7xl">
                THE NEW DATACENTER
                <br />
                HAS NO WALLS<span className="text-lima">.</span>
              </h1>
              <p className="mt-5 max-w-[52ch] text-sm leading-relaxed text-fog">
                Weaver is a decentralized compute network for the next generation of AI. Global GPUs. Open
                access. Higher intelligence.
              </p>
              <div className="mt-7 flex flex-wrap items-center gap-6">
                <a
                  href="/dashboard"
                  className="pointer-events-auto bg-lima px-7 py-3.5 text-base font-bold tracking-wide text-black transition-transform active:translate-y-[1px]"
                >
                  RUN LIVE DEMO →
                </a>
                <a href="#opportunity" className="pointer-events-auto font-tech text-xl tracking-[0.15em] hover:text-lima">
                  READ THE MANIFESTO
                </a>
              </div>
            </div>
            <div className="relative hidden lg:block">
              <div className="flex h-full items-center justify-center">
                <div className="relative aspect-square w-full max-w-[380px]">
                  <Image src="/weaver-mark.png" alt="Weaver — araña W" fill sizes="380px" className="object-contain mix-blend-screen" priority />
                </div>
              </div>
              <div className="absolute top-2 right-2 text-right font-tech text-sm leading-relaxed text-fog">
                COMPUTE
                <br />
                BELONGS
                <br />
                TO
                <br />
                EVERYONE
                <br />
                <span className="text-lima">{"//"}</span>
              </div>
            </div>
          </div>
          <span className="absolute top-3 left-4 z-10 font-tech text-lima">+</span>
          <span className="absolute top-3 right-4 z-10 font-tech text-lima">+</span>
          <div className="absolute bottom-5 left-5 z-10 border-l border-lima pl-3 font-tech text-sm leading-relaxed tracking-[0.15em] text-fog">
            [ 001 ]<br />
            DISTRIBUTED
            <br />
            SCALABLE
            <br />
            BORDERLESS
          </div>
          <div className="absolute right-5 bottom-5 z-10 text-right font-tech text-sm leading-relaxed tracking-[0.15em] text-fog">
            -34.6037°
            <br />
            -58.3816°
            <br />
            <span className="text-lima">{"//"}</span>
            <br />A GLOBAL
            <br />
            NETWORK
          </div>
        </section>

        {/* PILLARS */}
        <section id="pillars" className="scroll-mt-20 pt-10">
          <Pillars />
        </section>

        {/* OPPORTUNITY */}
        <section id="opportunity" className="scroll-mt-20 pt-14">
          <Opportunity deployment={deployment} forgeCount={forges?.length ?? null} hotCount={hot} />
        </section>

        {/* PRIVACY */}
        <section className="pt-14">
          <div className="border border-lima/60 bg-panel p-6 md:p-10">
            <div className="font-tech text-lg tracking-[0.2em] text-fog">
              <span className="text-lima">{"//"}</span> PRIVACY
            </div>
            <h2 className="mt-4 max-w-[18ch] text-4xl leading-[1.02] font-bold tracking-tight md:text-6xl">
              WE CAN&apos;T SELL WHAT WE DON&apos;T KEEP<span className="text-lima">.</span>
            </h2>
            <p className="mt-4 max-w-[60ch] text-sm leading-relaxed text-fog">
              No disk in the middle. Your prompts live in RAM and die with the request.
              The chain only ever sees money.
            </p>
            <div className="mt-8 grid grid-cols-1 gap-px bg-line md:grid-cols-3">
              {[
                ["PROMPTS", "die with the request"],
                ["CHATS", "yours, deletable, on your device"],
                ["LEDGER", "amounts + addresses, public forever"],
              ].map(([k, v]) => (
                <div key={k} className="bg-panel p-5">
                  <div className="font-tech text-lg tracking-[0.2em] text-lima">{k}</div>
                  <div className="mt-1 font-tech text-xl leading-snug">{v}</div>
                </div>
              ))}
            </div>
            <a
              href="/security"
              className="mt-6 inline-block border-b border-lima pb-1 font-tech text-xl tracking-[0.15em] text-white hover:text-lima"
            >
              READ THE SECURITY MODEL →
            </a>
          </div>
        </section>

        {/* TRUSTED */}
        <section className="pt-14">
          <Trusted />
        </section>
      </main>
      <footer className="mt-14 border-t border-line">
        <div className="mx-auto flex max-w-7xl flex-col gap-2 px-4 py-6 font-tech text-base tracking-[0.15em] text-fog md:flex-row md:items-center md:justify-between md:px-6">
          <span className="font-bold tracking-[0.3em] text-white">WEAVER</span>
          <span>OPEN COMPUTE. HIGHER INTELLIGENCE.</span>
          <span>EST. 2024</span>
        </div>
        <div className="flex justify-between px-4 font-tech text-lima md:px-6">
          <span>+</span>
          <span>+</span>
        </div>
      </footer>
    </>
  );
}
