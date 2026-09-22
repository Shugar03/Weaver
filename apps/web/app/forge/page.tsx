import Link from "next/link";
import { SiteHeader } from "../../components/SiteHeader";
import { forgeRow, type ForgeViewLike, type ExecSample } from "../../lib/fleet";

const GATEWAY = process.env.WEAVER_GATEWAY ?? "http://localhost:3001";

// Índice de la fleet: cada forge con su métrica real y link a su consola.
// Server-rendered (snapshot) — la consola de cada forge es la viva.
export default async function ForgeIndex() {
  const [forges, execs]: [ForgeViewLike[] | null, ExecSample[]] = await Promise.all([
    fetch(`${GATEWAY}/v1/forges`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
    fetch(`${GATEWAY}/v1/executions?limit=50`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => []),
  ]);

  return (
    <>
      <SiteHeader logoHref="/" links={[{ label: "Network", href: "/network" }, { label: "Chat", href: "/chat" }]} />
      <div className="mx-auto max-w-5xl px-4 py-10 md:px-6">
        <div className="font-tech text-base tracking-[0.2em] text-fog">FORGES</div>
        <h1 className="mt-1 text-4xl font-bold tracking-tight">La fleet, una consola por forge</h1>
        <p className="mt-2 text-sm text-fog">
          Cada fila muestra solo lo medido. Click en un forge para su consola (jobs, VRAM residente, payouts).
        </p>
        {forges === null ? (
          <div className="mt-8 border border-line bg-panel p-8 font-tech text-xl text-fog">
            <span className="text-danger">■</span> GATEWAY CAÍDO — node apps/gateway/src/serve.ts
          </div>
        ) : (
          <ul className="mt-8 divide-y divide-line border border-line bg-panel">
            {forges.map((f) => {
              const r = forgeRow(f, execs);
              return (
                <li key={f.forgeId}>
                  <Link href={r.href} className="grid grid-cols-[auto_1fr_auto_auto_auto] items-center gap-x-5 px-4 py-4 transition-colors hover:bg-lima/5">
                    <span
                      className={`inline-block h-2 w-2 rounded-full ${
                        r.status === "hot" ? "bg-lima" : r.status === "dead" ? "bg-danger" : "bg-fog"
                      }`}
                    />
                    <span>
                      <span className="font-tech text-xl">{f.forgeId}</span>
                      <span className="ml-3 font-tech text-base text-fog">{f.model}</span>
                      {r.sim && <span className="ml-3 border border-line px-1.5 py-0.5 font-tech text-sm text-fog">SIM</span>}
                    </span>
                    <span className="font-tech text-sm tracking-[0.15em] text-fog">
                      {f.capability === "image" ? "IMAGE" : "TEXT"}
                    </span>
                    <span className="font-tech text-lg">{r.metric}</span>
                    <span className="font-tech text-base text-fog">{r.jobs} jobs</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}
