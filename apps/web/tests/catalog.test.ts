// S48 — curación del marketplace: search/filtro/orden son reglas puras.
// available > medido > declarado; desempate por id. Nada de sort alfabético.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { filterModels, type CatalogModel } from "../lib/catalog.ts";

const mk = (id: string, over: Partial<CatalogModel> = {}): CatalogModel => ({
  id,
  name: null,
  description: null,
  context: null,
  features: [],
  docs: null,
  declared: false,
  pricing: { prompt: null, completion: null, image: null },
  availability: { providers: 0, hot: 0, available: false },
  measured: { ttftMsP50: null, tokPerSec: null },
  ...over,
});

const LIVE_MEASURED = mk("live-measured", {
  availability: { providers: 2, hot: 1, available: true },
  measured: { ttftMsP50: 200, tokPerSec: 50 },
});
const LIVE_ONLY = mk("live-only", { availability: { providers: 1, hot: 0, available: true } });
const DECLARED = mk("declared", { declared: true, name: "Unlisted Model" });
const NOTHING = mk("zzz-nothing");

describe("S48 filterModels orden curado", () => {
  const all = [NOTHING, DECLARED, LIVE_ONLY, LIVE_MEASURED];

  it("available+medido > available > declarado > resto", () => {
    assert.deepEqual(
      filterModels(all, {}).map((m) => m.id),
      ["live-measured", "live-only", "declared", "zzz-nothing"],
    );
  });

  it("search matchea id, name y description", () => {
    assert.deepEqual(filterModels(all, { q: "measured" }).map((m) => m.id), ["live-measured"]);
    assert.deepEqual(filterModels(all, { q: "unlisted" }).map((m) => m.id), ["declared"]);
    assert.equal(filterModels(all, { q: "nada-existe" }).length, 0);
  });

  it("feat filtra por capabilities; onlyAvail saca los offline", () => {
    const tools = mk("tools-model", { features: ["tools"], availability: { providers: 1, hot: 1, available: true } });
    const list = filterModels([...all, tools], { feat: "tools" });
    assert.deepEqual(list.map((m) => m.id), ["tools-model"]);
    assert.deepEqual(
      filterModels(all, { onlyAvail: true }).map((m) => m.id),
      ["live-measured", "live-only"],
    );
  });

  it("desempate por id (mismo rank → alfabético)", () => {
    const a = mk("b-model", { availability: { providers: 1, hot: 0, available: true } });
    const b = mk("a-model", { availability: { providers: 1, hot: 0, available: true } });
    assert.deepEqual(filterModels([a, b], {}).map((m) => m.id), ["a-model", "b-model"]);
  });
});
