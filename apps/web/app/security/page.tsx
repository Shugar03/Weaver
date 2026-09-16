import { SiteHeader } from "../../components/SiteHeader";

// Página pública de postura: qué retenemos (nada de contenido), qué vive en la
// cadena (metadatos, por diseño) y qué falta. Transparencia = puntos con el jurado.
const RETENTION: [string, string, string, boolean][] = [
  ["Prompts y respuestas", "RAM del request, GC al terminar", "Efímera", true],
  ["Chats de /chat", "localStorage de tu browser", "Solo tu máquina, borrable acá", true],
  ["Telemetría (forge, TTFT)", "Memoria del gateway, tope 500", "Hasta reiniciar", true],
  ["Modelos y pesos", "Tu disco (Ollama)", "Tuyos", true],
  ["Secrets Stellar", "~/.config, permisos 600", "Solo tu máquina", true],
  ["Secrets en repo", "—", "Escaneado, limpio", true],
  ["Montos, direcciones, txs", "Ledger Stellar público", "Para siempre, por diseño", true],
];

const CHECKS: [string, string, boolean][] = [
  ["Transporte local en loopback (127.0.0.1)", "OK", true],
  ["API keys wvr_ + admin solo operador", "OK", true],
  ["Caps anti-DoS (8k chars, 20 msgs, 413)", "OK", true],
  ["x402 que jamás voltea el gateway", "OK", true],
  ["Supply chain: lockfiles + audit limpio", "OK", true],
  ["Contrato: auth + atomicidad + overflow-checks", "OK", true],
  ["Sin tracking, sin cookies, XSS imposible por diseño", "OK", true],
  ["Rate limits por key", "PENDIENTE", false],
  ["Telemetría en Postgres con TTL+DELETE", "PENDIENTE", false],
  ["Verificación x402 contra Horizon propio", "PENDIENTE", false],
];

export default function Security() {
  return (
    <>
      <SiteHeader
        logoHref="/"
        links={[
          { label: "CHAT", href: "/chat" },
          { label: "CONSOLE", href: "/dashboard" },
          { label: "DEVELOPERS", href: "/developers" },
        ]}
        cta={{ label: "RUN LIVE DEMO →", href: "/dashboard" }}
      />
      <main className="mx-auto max-w-5xl px-4 pb-16 md:px-6">
        <section className="pt-10">
          <div className="font-tech text-lg tracking-[0.2em] text-fog">
            <span className="text-lima">{"//"}</span> SECURITY
          </div>
          <h1 className="mt-4 text-4xl leading-[1.02] font-bold tracking-tight md:text-6xl">
            Zero content retention<span className="text-lima">.</span>
          </h1>
          <p className="mt-4 max-w-[62ch] text-sm leading-relaxed text-fog">
            OpenAI guarda tus prompts para entrenar. Weaver no puede: no hay disco en el medio. Tus prompts
            viven en RAM durante el request y mueren con él; tus chats, solo en tu browser (con botón de
            borrar). Lo único permanente vive en el ledger público de Stellar: montos, direcciones y
            timestamps. Eso no es un bug, es la auditabilidad.
          </p>
        </section>

        <section className="pt-10">
          <div className="font-tech text-lg tracking-[0.2em] text-fog">
            <span className="text-lima">01</span> {"//"} DÓNDE VIVE CADA DATO
          </div>
          <div className="mt-4 divide-y divide-line border border-line bg-panel">
            {RETENTION.map(([dato, donde, ret]) => (
              <div key={dato} className="grid grid-cols-1 gap-1 px-4 py-3 md:grid-cols-3 md:gap-4">
                <span className="font-tech text-xl">{dato}</span>
                <span className="font-tech text-lg text-fog">{donde}</span>
                <span className="font-tech text-lg text-lima">{ret}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="pt-10">
          <div className="font-tech text-lg tracking-[0.2em] text-fog">
            <span className="text-lima">02</span> {"//"} END-TO-END, SIN CHAMUYO
          </div>
          <div className="mt-4 divide-y divide-line border border-line bg-panel">
            {CHECKS.map(([item, estado, ok]) => (
              <div key={item} className="flex items-center justify-between gap-4 px-4 py-3">
                <span className="text-sm">{item}</span>
                <span
                  className={`shrink-0 border px-2 py-0.5 font-tech text-base tracking-[0.15em] ${
                    ok ? "border-lima text-lima" : "border-line text-fog"
                  }`}
                >
                  {estado}
                </span>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-10 border border-line bg-panel p-5">
          <div className="font-tech text-lg tracking-[0.15em] text-fog">LÍMITES CONOCIDOS (TESTNET, RED LOCAL)</div>
          <p className="mt-2 text-sm leading-relaxed text-fog">
            Admin confía en acceso a la máquina · CORS abierto en local · telemetría muere al reiniciar ·
            plata de juguete. Nada de esto se esconde: está declarado acá y en el código.
          </p>
        </section>
      </main>
      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-5xl flex-col gap-2 px-4 py-6 font-tech text-base tracking-[0.15em] text-fog md:flex-row md:items-center md:justify-between md:px-6">
          <span className="font-bold tracking-[0.3em] text-white">WEAVER</span>
          <span>OPEN COMPUTE. HIGHER INTELLIGENCE.</span>
          <span>EST. 2024</span>
        </div>
      </footer>
    </>
  );
}
