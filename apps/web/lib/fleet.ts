// S26 — derivación forge→fila para la fleet. Puro, sin DOM ni fetch:
// las reglas de "qué número mostrar" viven acá y se testean con node:test.
// Regla de oro: solo lo medido (telemetría) o lo declarado honesto — nada
// fabricado (nada de LOAD% = loadTime/200 ni reliability hardcodeada).

export type ForgeViewLike = {
  forgeId: string;
  model: string;
  hot: boolean;
  queueMs: number;
  loadTimeMs: number;
  measuredTtftMs?: number;
  sim?: boolean;
  capability?: "text" | "image";
  // S29: carga real del gateway — inFlight medido, saturated = llegó al cap.
  inFlight?: number;
  saturated?: boolean;
  // S30/S35: forge remoto (WS, keypair propia) + attestation pasada.
  remote?: boolean;
  attested?: boolean;
};

export type ExecSample = {
  forgeId: string;
  model: string;
  ttftMs: number;
  ok: boolean;
  ts: number;
};

export type ForgeRow = {
  status: "hot" | "cold" | "dead";
  sim: boolean;
  busy: boolean; // saturated: existe pero no toma jobs ahora (≠ dead)
  metric: string; // "p50 1.89s" | "15.4s/img" | "load ~20s" | "warm" | "—"
  jobs: number;   // execs registradas de este forge (desde el boot)
  lastMs: number | null; // último job ok medido
  href: string;
  remote: boolean;   // llegó por WS con keypair propia (no embedded)
  verified: boolean; // attestation pasada (ejecuta + firma con su key)
};

const DEAD_QUEUE_MS = 99_999; // marcador del gateway: forge inalcanzable/muerto

const fmt = (ms: number) => (ms >= 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${(ms / 1000).toFixed(2)}s`);

export function forgeRow(f: ForgeViewLike, execs: ExecSample[]): ForgeRow {
  const mine = execs.filter((e) => e.forgeId === f.forgeId);
  const lastOk = mine.find((e) => e.ok); // recent() viene más nuevo primero
  const dead = f.queueMs >= DEAD_QUEUE_MS;
  const status: ForgeRow["status"] = dead ? "dead" : f.hot ? "hot" : "cold";
  const img = f.capability === "image";

  let metric = "—";
  if (!dead) {
    if (img) {
      // difusión no tiene TTFT: el dato honesto es ms por imagen — medido si
      // hay job, estimado de carga si no.
      metric = lastOk ? `${fmt(lastOk.ttftMs)}/img` : `~${Math.round(f.loadTimeMs / 1000)}s/img`;
    } else if (f.hot) {
      metric = f.measuredTtftMs !== undefined ? `p50 ${fmt(f.measuredTtftMs)}` : "warm";
    } else {
      metric = `load ~${Math.round(f.loadTimeMs / 1000)}s`;
    }
  }

  return {
    status,
    sim: f.sim === true,
    busy: !dead && f.saturated === true,
    metric,
    jobs: mine.length,
    lastMs: lastOk?.ttftMs ?? null,
    href: `/forge/${f.forgeId}`,
    remote: f.remote === true,
    verified: f.remote === true && f.attested === true,
  };
}
