import { Asterisk, DotsNine, Globe, Stack } from "@phosphor-icons/react/dist/ssr";

const PILLARS = [
  { icon: Globe, code: "01", title: "GLOBAL", sub: "COMPUTE" },
  { icon: Stack, code: "02", title: "DECENTRALIZED", sub: "BY DESIGN" },
  { icon: DotsNine, code: "03", title: "OPEN", sub: "ECOSYSTEM" },
  { icon: Asterisk, code: "04", title: "HIGHER", sub: "INTELLIGENCE" },
];

export function Pillars() {
  return (
    <div className="grid grid-cols-2 border border-line lg:grid-cols-4">
      {PILLARS.map((p, i) => (
        <div
          key={p.code}
          className={`flex items-center gap-4 p-6 ${i > 0 ? "max-lg:odd:border-l max-lg:[&:nth-child(n+3)]:border-t lg:border-l lg:first:border-l-0" : ""} border-line`}
        >
          <p.icon size={30} weight="thin" className="shrink-0 text-lima" aria-hidden />
          <div>
            <div className="font-tech text-sm tracking-[0.2em] text-lima">[ {p.code} ]</div>
            <div className="mt-1 font-tech text-xl leading-tight tracking-[0.12em]">
              {p.title}
              <br />
              {p.sub}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
