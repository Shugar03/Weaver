// Cliente /v1/catalog — marketplace (ADR-0007 P6). Server o client component;
// gateway caído → null (la UI muestra estado honesto, no ceros).
export type CatalogModel = {
  id: string;
  name: string | null;
  description: string | null;
  context: number | null;
  features: string[];
  docs: string | null;
  declared: boolean;
  pricing: { prompt: string | null; completion: string | null; image: string | null };
  availability: { providers: number; hot: number; available: boolean };
  measured: { ttftMsP50: number | null; tokPerSec: number | null };
};

export async function getCatalog(base: string): Promise<CatalogModel[] | null> {
  try {
    const r = await fetch(`${base}/v1/catalog`, { cache: "no-store" });
    if (!r.ok) return null;
    const j = (await r.json()) as { models: CatalogModel[] };
    return j.models;
  } catch {
    return null;
  }
}

// stroops/Mtok → USD/Mtok (1 USDC = 10^7 stroops)
export function usdPerMtok(stroops: string | null): number | null {
  if (stroops === null) return null;
  return Number(BigInt(stroops)) / 1e7;
}

export function fmtCtx(n: number | null): string {
  if (n === null) return "—";
  return n >= 1000 ? `${Math.round(n / 1024)}K` : String(n);
}

// Curación del marketplace — pura para testear (Hick: los defaults hacen la
// elección, no el sort alfabético). available > medido > declarado > resto.
export function filterModels(
  models: CatalogModel[],
  opts: { q?: string; feat?: string | null; onlyAvail?: boolean },
): CatalogModel[] {
  const needle = (opts.q ?? "").trim().toLowerCase();
  return models
    .filter((m) => {
      if (needle && !`${m.id} ${m.name ?? ""} ${m.description ?? ""}`.toLowerCase().includes(needle)) return false;
      if (opts.feat && !m.features.includes(opts.feat)) return false;
      if (opts.onlyAvail && !m.availability.available) return false;
      return true;
    })
    .sort((a, b) => rank(b) - rank(a) || a.id.localeCompare(b.id));
}

function rank(m: CatalogModel): number {
  return (m.availability.available ? 4 : 0) + (m.measured.ttftMsP50 !== null ? 2 : 0) + (m.declared ? 1 : 0);
}
