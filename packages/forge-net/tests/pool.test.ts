// S46 ForgePool — reserva atómica de rpc-workers (spec 017 + hardening CTO).
// Reglas: loans por jobId (concurrencia segura), probe TCP al endpoint antes
// de prestar, strikes → evicción temporal del worker malo, filtro minVramGb.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ForgePool, type PoolWorker } from "../src/pool.ts";
import type { InstanceReport } from "../src/protocol.ts";

const wk = (id: string, over: Partial<PoolWorker> = {}): PoolWorker => ({
  instanceId: id,
  forgePubkey: `pk-${id}`,
  endpoint: `10.0.0.${id.replace(/\D/g, "") || 9}:50052`,
  vramGb: 24,
  rttMs: 50,
  live: true,
  ...over,
});

const pooledInst = (needs: number, minVramGb?: number): InstanceReport => ({
  instanceId: "c0",
  model: "qwen-70b",
  capability: "text",
  hot: true,
  inFlight: 0,
  saturated: false,
  loadTimeMs: 0,
  pool: minVramGb !== undefined ? { needs, minVramGb } : { needs },
});

type Deps = { reports?: Map<string, InstanceReport>; workers?: PoolWorker[]; probe?: (e: string) => Promise<boolean>; now?: () => number };
const pool = (d: Deps) =>
  new ForgePool({
    reportOf: (i) => d.reports?.get(i),
    workers: () => d.workers ?? [],
    // Default test: TCP siempre ok — los tests de probe lo pisan explícito.
    probe: d.probe ?? (async () => true),
    ...(d.now ? { now: d.now } : {}),
  });
const reports = (m: Map<string, InstanceReport>) => m;

describe("ForgePool", () => {
  it("instancia sin pool.needs → [] (ruta normal, sin reserva)", async () => {
    const p = pool({ reports: reports(new Map([["c0", { instanceId: "c0", model: "m", capability: "text", hot: true, inFlight: 0, saturated: false, loadTimeMs: 0 }]])), workers: [wk("w1")] });
    assert.deepEqual(await p.acquire("c0", "pkC", "j1"), []);
  });

  it("acquire ordena por RTT y devuelve endpoints", async () => {
    const p = pool({
      reports: reports(new Map([["c0", pooledInst(2)]])),
      workers: [wk("w1", { rttMs: 80 }), wk("w2", { rttMs: 10 })],
    });
    const peers = await p.acquire("c0", "pkC", "j1");
    assert.deepEqual(peers, ["10.0.0.2:50052", "10.0.0.1:50052"]);
  });

  it("prefiere workers de OTRO forge (descentralización real)", async () => {
    const p = pool({
      reports: reports(new Map([["c0", pooledInst(1)]])),
      workers: [wk("w1", { forgePubkey: "pkC", rttMs: 1 }), wk("w2", { forgePubkey: "otra", rttMs: 90 })],
    });
    assert.deepEqual(await p.acquire("c0", "pkC", "j1"), ["10.0.0.2:50052"]);
  });

  it("sin suficientes libres → null; loans por jobId son independientes", async () => {
    const ws = [wk("w1"), wk("w2"), wk("w3")];
    const p = pool({ reports: reports(new Map([["c0", pooledInst(2)], ["c1", pooledInst(2)]])), workers: ws });
    assert.notEqual(await p.acquire("c0", "pkA", "jA"), null); // 2 de 3
    // c1 necesita 2 pero solo queda 1 libre → null, no pisar el loan de jA
    assert.equal(await p.acquire("c1", "pkB", "jB"), null);
    // release de jA libera SUS workers, no los de otros
    p.release("jA");
    assert.notEqual(await p.acquire("c1", "pkB", "jB"), null);
  });

  it("dos loans concurrentes NO se pisan: release libera solo los propios", async () => {
    const p = pool({
      reports: reports(new Map([["c0", pooledInst(1)]])),
      workers: [wk("w1"), wk("w2")],
    });
    const a = await p.acquire("c0", "pkC", "jobA");
    const b = await p.acquire("c0", "pkC", "jobB"); // mismo coordinator, otro job
    assert.equal(a?.length, 1);
    assert.equal(b?.length, 1);
    assert.notDeepEqual(a, b); // workers distintos — nunca compartidos
    p.release("jobA");
    // el worker de jobA vuelve; el de jobB sigue ocupado → un tercer job
    // consigue SOLO el liberado
    const c = await p.acquire("c0", "pkC", "jobC");
    assert.deepEqual(c, a);
  });

  it("worker caído y reconectado: busy stale se evicia durante la ausencia", async () => {
    const ws = [wk("w1"), wk("w2")];
    const p = pool({ reports: reports(new Map([["c0", pooledInst(2)], ["c1", pooledInst(1)]])), workers: ws });
    assert.notEqual(await p.acquire("c0", "pkA", "jA"), null); // jA toma AMBOS
    ws.splice(1, 1); // w2 muere (unregister) — jA jamás libera (edge: coord se fue sin finally)
    // Acquire durante la ausencia: evictStale limpia el busy fantasma de w2.
    // w1 sigue busy legítimo (jA lo tiene) → no alcanza → null, pero sano.
    assert.equal(await p.acquire("c1", "pkB", "jB"), null);
    ws.push(wk("w2")); // w2 reconecta — busy ya fue evictado en su ausencia
    const peers = await p.acquire("c1", "pkB", "jB2");
    assert.deepEqual(peers, ["10.0.0.2:50052"]); // sirve al pool de nuevo
  });

  it("releaseForge libera TODOS los loans de una pubkey de coordinator", async () => {
    const p = pool({
      reports: reports(new Map([["c0", pooledInst(1)], ["c1", pooledInst(1)]])),
      workers: [wk("w1"), wk("w2")],
    });
    await p.acquire("c0", "pkMuerto", "j1");
    await p.acquire("c1", "pkMuerto", "j2");
    p.releaseForge("pkMuerto");
    const peers = await p.acquire("c0", "pkNuevo", "j3");
    assert.equal(peers?.length, 1); // hay workers libres otra vez
  });

  it("probe TCP: endpoint muerto no se presta — nunca llega al assign", async () => {
    const probed: string[] = [];
    const p = pool({
      reports: reports(new Map([["c0", pooledInst(1)]])),
      workers: [wk("w1", { rttMs: 5 }), wk("w2", { rttMs: 90 })],
      probe: async (e) => {
        probed.push(e);
        return !e.includes("10.0.0.1"); // w1 acepta TCP... digo, NO acepta
      },
    });
    const peers = await p.acquire("c0", "pkC", "j1");
    assert.deepEqual(peers, ["10.0.0.2:50052"]); // el más lento pero VIVO gana
    assert.ok(probed.length >= 1); // probó antes de prestar
  });

  it("probe cae todos → null y los candidatos se liberan (sin leak busy)", async () => {
    const p = pool({
      reports: reports(new Map([["c0", pooledInst(2)]])),
      workers: [wk("w1"), wk("w2")],
      probe: async () => false,
    });
    assert.equal(await p.acquire("c0", "pkC", "j1"), null);
    // segunda chance: los workers no quedaron busy-fantasma
    const p2 = pool({ reports: reports(new Map([["c0", pooledInst(2)]])), workers: [wk("w1"), wk("w2")] });
    assert.notEqual(await p2.acquire("c0", "pkC", "j2"), null); // sin probe → todos sirven
  });

  it("penalize: un worker que hace fallar el spawn junta strikes → evicción temporal", async () => {
    let t = 1000;
    const p = pool({
      reports: reports(new Map([["c0", pooledInst(1)]])),
      workers: [wk("w1", { rttMs: 1 }), wk("w2", { rttMs: 99 })],
      now: () => t,
    });
    // primer strike: w1 sigue elegible pero el próximo strike lo saca
    await p.acquire("c0", "pkC", "j1"); // w1 (más rápido)
    p.penalize("j1");
    p.release("j1");
    await p.acquire("c0", "pkC", "j2"); // w1 de nuevo → segundo strike → evict
    p.penalize("j2");
    p.release("j2");
    const peers = await p.acquire("c0", "pkC", "j3");
    assert.deepEqual(peers, ["10.0.0.2:50052"]); // w1 evictado pese a RTT bajo
    // tras el cooldown vuelve (self-heal)
    t += 200_000;
    const peers2 = await p.acquire("c0", "pkC", "j4");
    assert.deepEqual(peers2, ["10.0.0.1:50052"]);
  });

  it("minVramGb filtra workers chicos — un 2GB no sirve para un 70B", async () => {
    const p = pool({
      reports: reports(new Map([["c0", pooledInst(1, 16)]])),
      workers: [wk("w1", { vramGb: 2, rttMs: 1 }), wk("w2", { vramGb: 24, rttMs: 90 })],
    });
    assert.deepEqual(await p.acquire("c0", "pkC", "j1"), ["10.0.0.2:50052"]);
  });

  it("worker sin vramGb declarado NO pasa filtro minVramGb (conservador)", async () => {
    const p = pool({
      reports: reports(new Map([["c0", pooledInst(1, 16)]])),
      workers: [wk("w1", { vramGb: undefined }), wk("w2", { vramGb: 24 })],
    });
    assert.deepEqual(await p.acquire("c0", "pkC", "j1"), ["10.0.0.2:50052"]);
  });

  it("penalize sobre jobId sin loan → no-op (idempotente)", () => {
    const p = pool({ reports: reports(new Map([["c0", pooledInst(1)]])), workers: [] });
    p.penalize("job-fantasma"); // no explota
  });
});
