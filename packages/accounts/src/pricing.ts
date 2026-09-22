// S47 (ADR-0007) — PricingBook: precio por modelo en stroops.
// prompt/completion: por millón de tokens (i128 stroops). image: flat por
// generación. Default conservador — el operador sobreescribe por
// MODEL_PRICING='{"qwen3:4b":{"prompt":50000,"completion":150000}}' (env, JSON).
export type ModelPrice = {
  prompt: bigint; // stroops por 1M prompt tokens
  completion: bigint; // stroops por 1M completion tokens
  image: bigint; // stroops flat por imagen
};

export type Usage = { promptTokens?: number; completionTokens?: number };

// Default honesto: ~$0.10/$0.30 por Mtok (precio local-barato, no cloud).
const DEFAULT_PRICE: ModelPrice = { prompt: 1_000_000n, completion: 3_000_000n, image: 500_000n };

export class PricingBook {
  private readonly table: Map<string, ModelPrice>;
  private readonly fallback: ModelPrice;

  constructor(table: Record<string, ModelPrice> = {}, fallback: ModelPrice = DEFAULT_PRICE) {
    this.table = new Map(Object.entries(table));
    this.fallback = fallback;
  }

  /** Precio del modelo; el fallback aplica a modelos sin entrada explícita. */
  priceFor(model: string): ModelPrice {
    return this.table.get(model) ?? this.fallback;
  }

  /** Costo de un chat job en stroops — medido post-serve (usage real). */
  costOf(model: string, usage: Usage): bigint {
    const p = this.priceFor(model);
    const pt = BigInt(Math.max(0, usage.promptTokens ?? 0));
    const ct = BigInt(Math.max(0, usage.completionTokens ?? 0));
    return (pt * p.prompt + ct * p.completion) / 1_000_000n;
  }

  /** Costo flat de una imagen. */
  costOfImage(model: string): bigint {
    return this.priceFor(model).image;
  }

  /** Estimación pre-serve para el check 402 — un job mínimo. */
  minCost(model: string, capability: "text" | "image" = "text"): bigint {
    if (capability === "image") return this.costOfImage(model);
    return this.priceFor(model).completion / 10n + 1n; // ~100k completion tokens margen
  }

  list(): { model: string; price: ModelPrice }[] {
    return [...this.table.entries()].map(([model, price]) => ({ model, price }));
  }
}

// Env: MODEL_PRICING='{"model":{"prompt":N,"completion":N,"image":N}}' (stroops/Mtok).
export function pricingFromEnv(raw?: string): PricingBook {
  if (!raw) return new PricingBook();
  try {
    const j = JSON.parse(raw) as Record<string, { prompt?: number; completion?: number; image?: number }>;
    return new PricingBook(
      Object.fromEntries(
        Object.entries(j).map(([m, p]) => [
          m,
          { prompt: BigInt(p.prompt ?? 0), completion: BigInt(p.completion ?? 0), image: BigInt(p.image ?? 0) },
        ]),
      ),
    );
  } catch {
    return new PricingBook(); // JSON roto → defaults, jamás crash de boot
  }
}
