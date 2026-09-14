import Image from "next/image";
import type { ReactNode } from "react";

export type NavLink = { label: string; href: string };

// Header compartido landing/dashboard. Solo cambia contenido, nunca el sistema.
export function SiteHeader({
  logoHref,
  links,
  cta,
  right,
}: {
  logoHref: string;
  links: NavLink[];
  cta?: NavLink;
  right?: ReactNode;
}) {
  return (
    <header className="border-b border-line">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 md:px-6">
        <a href={logoHref} className="flex items-center gap-3">
          <Image src="/weaver-logo.png" alt="Weaver" width={34} height={34} />
          <span className="text-lg font-bold tracking-[0.3em]">WEAVER</span>
        </a>
        <nav className="hidden items-center gap-8 font-tech text-lg tracking-[0.15em] text-fog md:flex">
          {links.map((n) => (
            <a key={n.label} href={n.href} className="transition-colors hover:text-white">
              {n.label}
            </a>
          ))}
        </nav>
        {cta ? (
          <a
            href={cta.href}
            className="border border-lima px-4 py-2 font-tech text-lg tracking-[0.15em] text-lima transition-colors hover:bg-lima hover:text-black"
          >
            {cta.label}
          </a>
        ) : null}
        {right}
      </div>
    </header>
  );
}
