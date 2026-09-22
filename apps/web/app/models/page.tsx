import { SiteHeader } from "../../components/SiteHeader";
import { ModelsApp } from "../../components/models/ModelsApp";

export default function Models() {
  const base = process.env.NEXT_PUBLIC_GATEWAY ?? process.env.WEAVER_GATEWAY ?? "http://localhost:3001";
  return (
    <>
      <SiteHeader
        logoHref="/"
        links={[
          { label: "CHAT", href: "/chat" },
          { label: "CONSOLE", href: "/network" },
          { label: "DOCS", href: "/developers" },
        ]}
        cta={{ label: "ACCOUNT", href: "/account" }}
      />
      <ModelsApp base={base} />
      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-7xl flex-col gap-2 px-4 py-6 font-tech text-base tracking-[0.15em] text-fog md:flex-row md:items-center md:justify-between md:px-6">
          <span className="font-bold tracking-[0.3em] text-white">WEAVER</span>
          <span>OPEN COMPUTE. HIGHER INTELLIGENCE.</span>
        </div>
      </footer>
    </>
  );
}
