// S19 — RoutedExec: la decisión del scheduler ES el dispatch.
// Cada request re-ordena la fleet con la función inyectada (ETR medido en prod)
// y hace failover sobre ese orden. Ya no hay lista estática paralela al scheduler.
// Genérico sobre la vista: forge-exec no conoce ForgeView ni Stellar.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RoutedExec } from "../src/routed.ts";
import type { ExecRequest, ForgeExec, StreamChunk } from "../src/ports.ts";

type V = { forgeId: string; model: string; cost: number };
const view = (forgeId: string, cost: number, model = "m"): V => ({ forgeId, model, cost });
const byCost = (_req: ExecRequest, vs: V[]) => [...vs].sort((a, b) => a.cost - b.cost);

class TokExec implements ForgeExec {
  readonly model = "m";
  readonly forgeId: string;
  constructor(forgeId: string) {
    this.forgeId = forgeId;
  }
  async *execute(): AsyncIterable<StreamChunk> {
    yield { token: `tok:${this.forgeId}`, done: false };
    yield { token: "", done: true };
  }
}

class DeadExec implements ForgeExec {
  readonly model = "m";
  readonly forgeId: string;
  constructor(forgeId: string) {
    this.forgeId = forgeId;
  }
  async *execute(): AsyncIterable<StreamChunk> {
    throw new Error("caído");
  }
}

async function collect(exec: ForgeExec, req?: Partial<ExecRequest>): Promise<string> {
  let out = "";
  for await (const c of exec.execute({ jobId: "j", model: "m", prompt: "h", ...req })) out += c.token;
  return out;
}

describe("S19 RoutedExec", () => {
  it("despacha al que dicta el orden, no al primero de la lista", async () => {
    const r = new RoutedExec<V>({
      forges: () => [view("caro", 900), view("barato", 1)],
      order: byCost,
      execs: { caro: new TokExec("caro"), barato: new TokExec("barato") },
    });
    assert.equal(await collect(r), "tok:barato");
  });

  it("muere el elegido pre-token → salta al siguiente del orden", async () => {
    const r = new RoutedExec<V>({
      forges: () => [view("muerto", 1), view("segundo", 2)],
      order: byCost,
      execs: { muerto: new DeadExec("muerto"), segundo: new TokExec("segundo") },
    });
    assert.equal(await collect(r), "tok:segundo");
  });

  it("sin views del modelo → throw explícito, jamás silencio", async () => {
    const r = new RoutedExec<V>({ forges: () => [view("x", 1, "otro")], order: byCost, execs: {} });
    await assert.rejects(collect(r), /sin execs/);
  });

  it("view sin exec registrado se saltea (fleet declara más de lo que despacha)", async () => {
    const r = new RoutedExec<V>({
      forges: () => [view("fantasma", 1), view("real", 2)],
      order: byCost,
      execs: { real: new TokExec("real") },
    });
    assert.equal(await collect(r), "tok:real");
  });

  it("onForge reporta el que sirvió de verdad, no el elegido", async () => {
    const seen: string[] = [];
    const r = new RoutedExec<V>({
      forges: () => [view("muerto", 1), view("real", 2)],
      order: byCost,
      execs: { muerto: new DeadExec("muerto"), real: new TokExec("real") },
    });
    await collect(r, { onForge: (id) => seen.push(id) });
    assert.deepEqual(seen, ["real"]);
  });

  it("forges async (registry real) también funciona", async () => {
    const r = new RoutedExec<V>({
      forges: async () => [view("a", 1)],
      order: byCost,
      execs: { a: new TokExec("a") },
    });
    assert.equal(await collect(r), "tok:a");
  });
});
