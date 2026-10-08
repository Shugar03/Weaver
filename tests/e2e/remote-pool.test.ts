// S46 e2e — pool-forge sobre wire real (spec 017):
//   rpc-worker heartbeatea su endpoint → coordinator pooled recibe job.assign
//   con rpcPeers → pooledFactory resuelve el engine → job sirve.
//   Worker muerto → pool.acquire falla → failover honesto, no cuelga.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { FakeForgeExec } from "@weaver/forge-exec";
import {
  startStack,
  upRpcDaemon,
  upPooledDaemon,
  untilAttested,
  chatRequest,
  sleep,
  type Stack,
} from "./harness.ts";
import type { ForgeDaemon } from "@weaver/forge";

const stacks: Stack[] = [];
const daemons: ForgeDaemon[] = [];
after(() => {
  for (const d of daemons) d.stop();
  for (const s of stacks) s.close();
});

const untilWorkers = async (stack: Stack, n: number, ms = 5000): Promise<void> => {
  const t0 = Date.now();
  while (stack.registry.workers().length < n && Date.now() - t0 < ms) await sleep(50);
};

describe("S46 pool-forge wire e2e", () => {
  it("coordinator pooled recibe rpcPeers del worker real y sirve el job", async () => {
    const stack = await startStack();
    stacks.push(stack);
    // Worker primero: su endpoint debe estar en workers() antes de que el
    // coordinator se attestée (la attestation YA consume el pool).
    const w = await upRpcDaemon(stack, "w0", "10.99.0.5:50052", { alive: true });
    daemons.push(w.daemon);
    await untilWorkers(stack, 1);

    const engine = new FakeForgeExec({ forgeId: "c0", model: "qwen3.5:4b" });
    // Factoría espiada: prueba de que el daemon recibió rpcPeers REALES.
    const seenPeers: string[][] = [];
    const c = await upPooledDaemon(stack, "c0", engine, 1, undefined, (peers) => {
      seenPeers.push(peers);
      return engine;
    });
    daemons.push(c.daemon);
    await untilAttested(stack.registry, 1); // attest pasó CON worker prestado

    const res = await chatRequest(stack.url, "hola", { allowPooled: true });
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /\[DONE\]/);
    // El daemon invocó pooledFactory con el endpoint REAL del worker —
    // la coordinación Weaver funcionó sobre el wire, no en unit.
    assert.ok(seenPeers.length >= 1);
    assert.deepEqual(seenPeers[0], ["10.99.0.5:50052"]);
  });

  it("worker muerto → pool.acquire sin libres → error honesto (no cuelga)", async () => {
    const stack = await startStack();
    stacks.push(stack);
    const w = await upRpcDaemon(stack, "w1", "10.99.0.6:50052", { alive: true });
    daemons.push(w.daemon);
    await untilWorkers(stack, 1);
    const c = await upPooledDaemon(stack, "c1", new FakeForgeExec({ forgeId: "c1", model: "qwen3.5:4b" }), 1);
    daemons.push(c.daemon);
    await untilAttested(stack.registry, 1);

    w.daemon.stop(); // el worker forge muere — unregister inmediato
    const t0 = Date.now();
    while (stack.registry.workers().length > 0 && Date.now() - t0 < 4000) await sleep(50);
    assert.equal(stack.registry.workers().length, 0);

    const res = await chatRequest(stack.url, "hola", { allowPooled: true });
    // SSE flushea 200 al abrir — el fallo del pool viaja en-stream como
    // frame {"error":"forge-failed"}: honesto, no cuelga ni inventa output.
    const body = await res.text();
    assert.match(body, /forge-failed|error/);
  });

  it("coordinator llega ANTES que sus workers → attest transient → retry → sirve", async () => {
    const stack = await startStack();
    stacks.push(stack);
    // Coordinator PRIMERO: el attest inicial no encuentra workers y falla
    // — condición transiente, no forge roto.
    const c = await upPooledDaemon(stack, "c3", new FakeForgeExec({ forgeId: "c3", model: "qwen3.5:4b" }), 1);
    daemons.push(c.daemon);
    await sleep(900); // el attest falló al menos una vez
    assert.equal(stack.registry.views().filter((v) => v.attested).length, 0); // sin attested todavía
    const res = await chatRequest(stack.url, "hola", { allowPooled: true });
    assert.match(await res.text(), /forge-failed|error/); // unroutable ahora, no colgado

    // El worker conecta DESPUÉS — el retry (400ms en e2e) lo levanta.
    const w = await upRpcDaemon(stack, "w3", "10.99.0.8:50052", { alive: true });
    daemons.push(w.daemon);
    await untilAttested(stack.registry, 1, 10_000); // self-heal real por el wire
    const res2 = await chatRequest(stack.url, "hola", { allowPooled: true });
    assert.equal(res2.status, 200);
    assert.match(await res2.text(), /\[DONE\]/);
  });

  it("worker se recupera → el pool vuelve a servir", async () => {
    const stack = await startStack();
    stacks.push(stack);
    const proc = { alive: true };
    const w = await upRpcDaemon(stack, "w2", "10.99.0.7:50052", proc);
    daemons.push(w.daemon);
    await untilWorkers(stack, 1);
    const c = await upPooledDaemon(stack, "c2", new FakeForgeExec({ forgeId: "c2", model: "qwen3.5:4b" }), 1);
    daemons.push(c.daemon);
    await untilAttested(stack.registry, 1);
    assert.equal((await chatRequest(stack.url, "hola", { allowPooled: true })).status, 200);

    proc.alive = false; // rpc-server cae pero el daemon sigue heartbeateando
    const t0 = Date.now();
    while (stack.registry.workers().some((x) => x.live) && Date.now() - t0 < 4000) await sleep(50);
    const res = await chatRequest(stack.url, "hola", { allowPooled: true });
    assert.match(await res.text(), /forge-failed|error/); // live:false → no elegible

    proc.alive = true; // vuelve el rpc-server
    const t1 = Date.now();
    while (!stack.registry.workers().some((x) => x.live) && Date.now() - t1 < 4000) await sleep(50);
    const res2 = await chatRequest(stack.url, "hola", { allowPooled: true });
    assert.equal(res2.status, 200); // y el pool sirve de nuevo
    assert.match(await res2.text(), /\[DONE\]/);
  });
});
