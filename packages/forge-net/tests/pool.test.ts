// S46 — ForgePool (spec 017): reserva atómica de rpc-workers para
// coordinators pooled. Deps fake — la verdad viva es el registry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ForgePool, type PoolWorker } from "../src/pool.ts";
import type { InstanceReport } from "../src/protocol.ts";

const inst = (over: Partial<InstanceReport> = {}): InstanceReport => ({
  instanceId: "c0",
  model: "qwen-70b",
  capability: "text",
  hot: true,
  inFlight: 0,
  saturated: false,
  loadTimeMs: 5000,
  ...over,
});
const worker = (over: Partial<PoolWorker> = {}): PoolWorker => ({
  instanceId: "w0",
  forgePubkey: "PK_WORKER",
  endpoint: "10.0.0.5:50052",
  rttMs: 20,
  live: true,
  ...over,
});
const mk = (reports: InstanceReport[], workers: PoolWorker[]) =>
  new ForgePool({
    reportOf: (id) => reports.find((r) => r.instanceId === id),
    workers: () => workers,
  });

test("instance sin pool → acquire devuelve [] (ruta normal, nada reservado)", () => {
  const p = mk([inst()], [worker()]);
  assert.deepEqual(p.acquire("c0", "PK_COORD"), []);
});

test("pool.needs=2 con 2 workers libres → endpoints; mismo loan no duplica", () => {
  const p = mk(
    [inst({ pool: { needs: 2 } }), inst({ instanceId: "c1", pool: { needs: 2 } })],
    [worker({ endpoint: "a:1", rttMs: 30 }), worker({ instanceId: "w1", endpoint: "b:2", rttMs: 10 })],
  );
  const peers = p.acquire("c0", "PK_COORD");
  assert.deepEqual(peers, ["b:2", "a:1"]); // menor RTT primero — cadena corta
  // Recién prestados, un segundo acquire no encuentra suficientes libres.
  assert.equal(p.acquire("c1", "PK_COORD"), null);
});

test("preferencia: workers de OTRO forge antes que el propio (claim 'desconocidos')", () => {
  const p = mk(
    [inst({ pool: { needs: 1 } })],
    [
      worker({ forgePubkey: "PK_COORD", endpoint: "mismo:1", rttMs: 5 }), // el mío, más rápido
      worker({ forgePubkey: "PK_OTRO", endpoint: "otro:2", rttMs: 50 }),  // el de otro, más lento
    ],
  );
  assert.deepEqual(p.acquire("c0", "PK_COORD"), ["otro:2"]);
});

test("worker no-live (rpc-server caído) no es elegible", () => {
  const p = mk([inst({ pool: { needs: 1 } })], [worker({ live: false })]);
  assert.equal(p.acquire("c0", "PK_COORD"), null);
});

test("release devuelve workers al pool; stale busy se evicia perezosamente", () => {
  const ws = [worker({ endpoint: "a:1" })];
  const p = mk(
    [inst({ pool: { needs: 1 } }), inst({ instanceId: "c1", pool: { needs: 1 } }), inst({ instanceId: "c2", pool: { needs: 1 } })],
    ws,
  );
  assert.deepEqual(p.acquire("c0", "PK_COORD"), ["a:1"]);
  assert.equal(p.acquire("c1", "PK_COORD"), null); // prestado
  p.release("c0");
  assert.deepEqual(p.acquire("c1", "PK_COORD"), ["a:1"]);
  // stale: worker prestado a c1 desaparece del registry → siguiente acquire
  // lo evicia aunque nadie llamó release (muerte por desconexión).
  ws.length = 0; // el worker forge murió — ya no heartbeatea
  ws.push(worker({ instanceId: "w9", endpoint: "n:9" }));
  assert.deepEqual(p.acquire("c2", "PK_COORD"), ["n:9"]); // w0 stale evicted, w9 libre
});

test("releaseForge libera todos los loans de un coordinator muerto", () => {
  const p = mk(
    [inst({ pool: { needs: 1 } }), inst({ instanceId: "c9", pool: { needs: 1 } })],
    [worker({ endpoint: "a:1" }), worker({ instanceId: "w1", endpoint: "b:2" })],
  );
  p.acquire("c0", "PK_COORD"); // w0
  p.releaseForge("PK_COORD");
  assert.deepEqual(p.acquire("c9", "PK_OTRO"), ["a:1"]); // w0 liberado
});
