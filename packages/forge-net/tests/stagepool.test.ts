// S47 — StagePool: cadena de stage-workers por cobertura de bloques,
// leases por jobId, probe TCP, strikes → evicción (spec 018).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { StagePool, type StageWorker } from "../src/stagepool.ts";
import type { InstanceReport } from "../src/protocol.ts";

const stg = (over: Partial<StageWorker> = {}): StageWorker => ({
  instanceId: "s0",
  forgePubkey: "PK_B",
  model: "qwen-235b",
  endpoint: "10.0.0.5:50100",
  layers: [0, 40],
  rttMs: 40,
  live: true,
  ...over,
});

const coord = (blocks = 80): InstanceReport => ({
  instanceId: "c0",
  model: "qwen-235b",
  capability: "text",
  hot: true,
  inFlight: 0,
  saturated: false,
  loadTimeMs: 5000,
  pipeline: { blocks },
});

const pool = (workers: StageWorker[], reports: InstanceReport[] = [coord()], probe: (e: string) => Promise<boolean> = async () => true) =>
  new StagePool({
    reportOf: (id) => reports.find((r) => r.instanceId === id),
    stageWorkers: () => workers,
    probe,
  });

describe("S47 StagePool", () => {
  it("cadena de 2 stages cubre [0..80) ordenada por rango", async () => {
    const p = pool([
      stg({ instanceId: "s2", endpoint: "10.0.0.6:50100", layers: [40, 80] }),
      stg({ instanceId: "s1", endpoint: "10.0.0.5:50100", layers: [0, 40] }),
    ]);
    const chain = await p.acquire("c0", "PK_A", "j1");
    assert.deepEqual(
      chain?.map((s) => s.blocks),
      [
        [0, 40],
        [40, 80],
      ],
    );
    assert.equal(chain?.[0].endpoint, "10.0.0.5:50100");
  });

  it("un stage que cubre todo el modelo → cadena de 1", async () => {
    const p = pool([stg({ layers: [0, 90] })]);
    const chain = await p.acquire("c0", "PK_A", "j1");
    assert.deepEqual(chain?.map((s) => s.blocks), [[0, 80]]);
  });

  it("hueco en la cobertura → null honesto (no cadena truncada)", async () => {
    const p = pool([stg({ layers: [0, 40] })]); // falta [40..80)
    assert.equal(await p.acquire("c0", "PK_A", "j1"), null);
  });

  it("candidato arranca más allá de pos → gap → null", async () => {
    const p = pool([
      stg({ instanceId: "s1", layers: [0, 30] }),
      stg({ instanceId: "s2", endpoint: "10.0.0.6:1", layers: [50, 80] }), // no cubre 30
    ]);
    assert.equal(await p.acquire("c0", "PK_A", "j1"), null);
  });

  it("stage puede servir subrango de su rango hospedado ([40..80) cuando hostea [20..80))", async () => {
    const p = pool([
      stg({ instanceId: "s1", layers: [0, 40] }),
      stg({ instanceId: "s2", endpoint: "10.0.0.6:1", layers: [20, 80] }), // hostea 20-80, le toca 40-80
    ]);
    const chain = await p.acquire("c0", "PK_A", "j1");
    assert.deepEqual(
      chain?.map((s) => s.blocks),
      [
        [0, 40],
        [40, 80],
      ],
    );
  });

  it("prefiere stage de OTRO forge sobre el del propio coordinator", async () => {
    const p = pool([
      stg({ instanceId: "s-mio", forgePubkey: "PK_A", endpoint: "10.0.0.7:1", layers: [0, 80] }),
      stg({ instanceId: "s-otro", forgePubkey: "PK_B", endpoint: "10.0.0.5:1", layers: [0, 80] }),
    ]);
    const chain = await p.acquire("c0", "PK_A", "j1");
    assert.equal(chain?.[0].endpoint, "10.0.0.5:1"); // el de PK_B, no el propio
  });

  it("workers busy → excluidos del pairing; release los devuelve", async () => {
    const p = pool([stg({ layers: [0, 80] })]);
    const c1 = await p.acquire("c0", "PK_A", "j1");
    assert.equal(c1?.length, 1);
    // j2 pide la misma cobertura pero el único stage está prestado → null
    assert.equal(await p.acquire("c0", "PK_A", "j2"), null);
    p.release("j1");
    const c3 = await p.acquire("c0", "PK_A", "j3");
    assert.equal(c3?.length, 1);
  });

  it("probe falla → strike + re-chain con el candidato sano", async () => {
    const p = pool(
      [
        stg({ instanceId: "s-malo", endpoint: "10.0.0.9:1", layers: [0, 40], rttMs: 10 }), // más rápido, pero muerto
        stg({ instanceId: "s-bueno", endpoint: "10.0.0.5:1", layers: [0, 40], rttMs: 50 }),
        stg({ instanceId: "s-fin", endpoint: "10.0.0.6:1", layers: [40, 80] }),
      ],
      [coord()],
      async (e) => e !== "10.0.0.9:1",
    );
    const chain = await p.acquire("c0", "PK_A", "j1");
    assert.deepEqual(
      chain?.map((s) => s.endpoint),
      ["10.0.0.5:1", "10.0.0.6:1"],
    ); // s-malo quedó fuera
  });

  it("todos los candidatos de un tramo mueren el probe → null tras reintentos", async () => {
    const p = pool([stg()], [coord()], async () => false);
    assert.equal(await p.acquire("c0", "PK_A", "j1"), null);
  });

  it("stage muerto o modelo distinto → no elegible", async () => {
    const p = pool([
      stg({ instanceId: "s1", live: false, layers: [0, 80] }),
      stg({ instanceId: "s2", model: "otro-modelo", endpoint: "10.0.0.6:1", layers: [0, 80] }),
    ]);
    assert.equal(await p.acquire("c0", "PK_A", "j1"), null);
  });

  it("penalize(jobId) → los stages del loan acumulan strike", async () => {
    const probados: string[] = [];
    const p = pool([stg({ layers: [0, 80] })], [coord()], async (e) => {
      probados.push(e);
      return true;
    });
    await p.acquire("c0", "PK_A", "j1");
    p.penalize("j1");
    p.release("j1");
    await p.acquire("c0", "PK_A", "j2");
    p.penalize("j2");
    p.release("j2");
    // 2 strikes → evictado 120s → el próximo acquire no lo ve
    assert.equal(await p.acquire("c0", "PK_A", "j3"), null);
  });

  it("instancia sin pipeline declarado → [] (ruta normal, no error)", async () => {
    const p = pool([stg()], [{ ...coord(), pipeline: undefined }]);
    assert.deepEqual(await p.acquire("c0", "PK_A", "j1"), []);
  });

  it("replace: stage muerto por endpoint → spare elegido, strike al muerto, nuevo en el loan", async () => {
    const workers = [
      stg({ instanceId: "s1", endpoint: "10.0.0.5:1", layers: [0, 40] }),
      stg({ instanceId: "s2", endpoint: "10.0.0.6:1", layers: [40, 80] }),
      stg({ instanceId: "s-spare", endpoint: "10.0.0.7:1", layers: [0, 40] }),
    ];
    const p = pool(workers);
    await p.acquire("c0", "PK_A", "j1");
    // stage.need: el coordinator reporta el muerto por endpoint + tramo.
    const rep = await p.replace("j1", "10.0.0.5:1", [0, 40]);
    assert.deepEqual(rep, { endpoint: "10.0.0.7:1", blocks: [0, 40] });
    // El spare quedó dentro del loan: release(j1) lo libera para un próximo acquire.
    p.release("j1");
    const c = await p.acquire("c0", "PK_A", "j2");
    assert.equal(c?.length, 2); // cadena completa disponible otra vez
  });

  it("replace: sin spare que cubra el tramo → null honesto", async () => {
    const p = pool([
      stg({ instanceId: "s1", endpoint: "10.0.0.5:1", layers: [0, 40] }),
      stg({ instanceId: "s2", endpoint: "10.0.0.6:1", layers: [40, 80] }),
    ]);
    await p.acquire("c0", "PK_A", "j1");
    assert.equal(await p.replace("j1", "10.0.0.5:1", [0, 40]), null);
  });

  it("replace: jobId sin loan → null (endpoint ajeno no toca nada)", async () => {
    const p = pool([stg()]);
    assert.equal(await p.replace("job-fantasma", "10.0.0.5:50100", [0, 40]), null);
  });

  it("replace: el muerto acumula strike → a la segunda muerte queda evictado", async () => {
    const workers = [
      stg({ instanceId: "s1", endpoint: "10.0.0.5:1", layers: [0, 40] }),
      stg({ instanceId: "s2", endpoint: "10.0.0.6:1", layers: [40, 80] }),
      stg({ instanceId: "sp1", endpoint: "10.0.0.7:1", layers: [0, 40] }),
      stg({ instanceId: "sp2", endpoint: "10.0.0.8:1", layers: [0, 40] }),
    ];
    const p = pool(workers);
    await p.acquire("c0", "PK_A", "j1");
    await p.replace("j1", "10.0.0.5:1", [0, 40]); // strike 1 al muerto
    await p.replace("j1", "10.0.0.7:1", [0, 40]); // ojo: sp1 ahora "muere" — strike a él
    p.release("j1");
    // s1 sigue elegible (1 strike < 2). Segunda muerte de s1 en otro job:
    await p.acquire("c0", "PK_A", "j2");
    await p.replace("j2", "10.0.0.5:1", [0, 40]); // strike 2 → evictado 120s
    p.release("j2");
    // s1 ya no es elegible — el tramo [0,40) lo cubre sp1 (1 strike, aún vivo).
    const c = await p.acquire("c0", "PK_A", "j3");
    assert.equal(c?.[0].endpoint, "10.0.0.7:1");
  });
});
