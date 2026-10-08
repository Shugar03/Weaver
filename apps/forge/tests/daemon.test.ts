// S33 — ForgeDaemon (lado daemon del protocolo): heartbeat con capacidad
// MEDIDA local, dispatch de job.assign/image.assign a los execs locales,
// proof L0 firmado con la keypair del forge. Canal falso — sin sockets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { FakeForgeExec, TrackedExec, promptHashOf, commitProof, type ForgeExec } from "@weaver/forge-exec";
import type { DaemonChannel, ForgeMsg, GatewayMsg } from "@weaver/forge-net";
import { ForgeDaemon, type DaemonInstance } from "../src/daemon.ts";

// Channel fake duplex: el test inyecta GatewayMsg, captura ForgeMsg.
class FakeChannel implements DaemonChannel {
  readonly sent: ForgeMsg[] = [];
  private msgCbs = new Set<(m: GatewayMsg) => void>();
  private closeCbs = new Set<() => void>();
  alive = true;
  send(m: ForgeMsg): void {
    this.sent.push(m);
  }
  onMessage(cb: (m: GatewayMsg) => void): () => void {
    this.msgCbs.add(cb);
    return () => this.msgCbs.delete(cb);
  }
  onClose(cb: () => void): () => void {
    this.closeCbs.add(cb);
    return () => this.closeCbs.delete(cb);
  }
  isAlive(): boolean {
    return this.alive;
  }
  inject(m: GatewayMsg): void {
    for (const cb of this.msgCbs) cb(m);
  }
  close(): void {
    this.alive = false;
    for (const cb of this.closeCbs) cb();
  }
  last<T extends ForgeMsg["type"]>(type: T): Extract<ForgeMsg, { type: T }> | undefined {
    return [...this.sent].reverse().find((m) => m.type === type) as never;
  }
}

const sign = (hash: Buffer) => createHash("sha256").update(hash).digest(); // firma fake determinística

function inst(exec: NonNullable<DaemonInstance["exec"]>, over: Partial<DaemonInstance> = {}): DaemonInstance {
  return {
    instanceId: exec.forgeId,
    model: exec.model,
    capability: "text",
    exec,
    maxConcurrent: 4,
    loadTimeMs: 1000,
    ...over,
  };
}

test("ping del gateway → pong con el mismo t (RTT medido)", () => {
  const ch = new FakeChannel();
  const d = new ForgeDaemon({ channel: ch, instances: [inst(new FakeForgeExec({ forgeId: "i1" }))], sign });
  d.start();
  ch.inject({ type: "ping", t: 12345 });
  assert.deepEqual(ch.last("pong"), { type: "pong", t: 12345 });
  d.stop();
});

test("heartbeat reporta capacidad real por instance (hot/inFlight/saturated)", async () => {
  const ch = new FakeChannel();
  const exec = new TrackedExec(new FakeForgeExec({ forgeId: "gpu0", model: "qwen3:4b" }));
  const d = new ForgeDaemon({
    channel: ch,
    instances: [inst(exec, { maxConcurrent: 1 })],
    sign,
    heartbeatMs: 10,
  });
  d.start();
  // Un stream en vuelo → inFlight:1 + saturated (cap=1).
  const it = exec.execute({ jobId: "j", model: "qwen3:4b", prompt: "x" })[Symbol.asyncIterator]();
  await it.next();
  await new Promise((r) => setTimeout(r, 30));
  const hb = ch.last("heartbeat");
  assert.ok(hb);
  const rep = hb.instances.find((i) => i.instanceId === "gpu0")!;
  assert.equal(rep.inFlight, 1);
  assert.equal(rep.saturated, true);
  assert.equal(rep.capability, "text");
  d.stop();
});

test("job.assign → ack → chunks → done con hash+firma del output", async () => {
  const ch = new FakeChannel();
  const exec = new FakeForgeExec({ forgeId: "gpu0", model: "qwen3:4b" });
  const d = new ForgeDaemon({ channel: ch, instances: [inst(exec)], sign });
  d.start();
  ch.inject({
    type: "job.assign",
    jobId: "job1",
    instanceId: "gpu0",
    model: "qwen3:4b",
    prompt: "hola",
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(ch.last("job.ack"), { type: "job.ack", jobId: "job1" });
  const done = ch.last("job.done")!;
  assert.equal(done.jobId, "job1");
  // Commitment era: resultHash = sha256(promptHash‖outputHash) — firma ata
  // input+output. outputHash es sha256 del contenido visible.
  const outHash = createHash("sha256").update("echo:hola", "utf8").digest();
  const pH = promptHashOf({ model: "qwen3:4b", prompt: "hola" });
  const expectCommit = commitProof(pH, outHash);
  assert.equal(done.outputHash, outHash.toString("hex"));
  assert.equal(done.promptHash, pH.toString("hex"));
  assert.equal(done.resultHash, expectCommit.toString("hex"));
  assert.equal(done.signature, sign(expectCommit).toString("hex"));
  d.stop();
});

test("job con chunks think → resultHash ata solo el contenido visible", async () => {
  // Mismo bug que proven.ts (PROOF ✗ en thinking models): el hasher del
  // daemon metía los tokens de razonamiento — el chip del cliente hashea
  // solo el contenido. kind:"think" queda fuera del hash.
  class Thinking extends FakeForgeExec {
    override async *execute(): AsyncIterable<import("@weaver/forge-exec").StreamChunk> {
      yield { token: "piensa ", done: false, kind: "think" };
      yield { token: "echo:hola", done: false, kind: "content" };
      yield { token: "", done: true };
    }
  }
  const ch = new FakeChannel();
  const d = new ForgeDaemon({ channel: ch, instances: [inst(new Thinking({ forgeId: "gpu0", model: "qwen3:4b" }))], sign });
  d.start();
  ch.inject({ type: "job.assign", jobId: "jt", instanceId: "gpu0", model: "qwen3:4b", prompt: "hola" });
  await new Promise((r) => setTimeout(r, 50));
  const done = ch.last("job.done")!;
  const expectHash = createHash("sha256").update("echo:hola", "utf8").digest();
  assert.equal(done.outputHash, expectHash.toString("hex"), "think fuera del outputHash — el receipt ata lo leído");
  // commitment = sha256(promptHash‖outputHash) — el input también ata.
  const pH = promptHashOf({ model: "qwen3:4b", prompt: "hola" });
  assert.equal(done.resultHash, commitProof(pH, expectHash).toString("hex"));
  d.stop();
});

test("job.assign con resume → el exec recibe el prefijo y el promptHash lo ata", async () => {
  // Mid-stream resume: el gateway re-despacha con resume.prefix — el daemon
  // debe pasarlo al exec (el adapter lo convierte en continuación) y meterlo
  // en el commitment, o el gateway rechaza el proof como mintiendo el input.
  let seen: string | undefined;
  class Spy extends FakeForgeExec {
    override async *execute(r: import("@weaver/forge-exec").ExecRequest): AsyncIterable<import("@weaver/forge-exec").StreamChunk> {
      seen = r.resume?.prefix;
      yield { token: "continúa", done: false, kind: "content" };
      yield { token: "", done: true };
    }
  }
  const ch = new FakeChannel();
  const d = new ForgeDaemon({ channel: ch, instances: [inst(new Spy({ forgeId: "gpu0", model: "qwen3:4b" }))], sign });
  d.start();
  ch.inject({
    type: "job.assign",
    jobId: "jR",
    instanceId: "gpu0",
    model: "qwen3:4b",
    prompt: "hola",
    resume: { prefix: "el otro dijo: " },
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(seen, "el otro dijo: ");
  const done = ch.last("job.done")!;
  const pH = promptHashOf({ model: "qwen3:4b", prompt: "hola", resume: "el otro dijo: " });
  const oH = createHash("sha256").update("continúa", "utf8").digest();
  assert.equal(done.promptHash, pH.toString("hex"));
  assert.equal(done.resultHash, commitProof(pH, oH).toString("hex"));
  d.stop();
});

test("job.cancel → el exec en vuelo recibe el abort (GPU liberada)", async () => {
  // Sin este wire, un cliente que se va dejaba al forge terminando el job en
  // vacío. El daemon expone AbortController por jobId → req.signal aborta.
  let aborted = false;
  let resolveBlock!: () => void;
  const block = new Promise<void>((r) => (resolveBlock = r));
  class Slow extends FakeForgeExec {
    override async *execute(r: import("@weaver/forge-exec").ExecRequest): AsyncIterable<import("@weaver/forge-exec").StreamChunk> {
      yield { token: "t1", done: false };
      await block; // queda colgado hasta el cancel
      aborted = r.signal?.aborted ?? false;
      yield { token: "nunca", done: false };
    }
  }
  const ch = new FakeChannel();
  const d = new ForgeDaemon({ channel: ch, instances: [inst(new Slow({ forgeId: "gpu0", model: "m" }))], sign });
  d.start();
  ch.inject({ type: "job.assign", jobId: "jC", instanceId: "gpu0", model: "m", prompt: "p" });
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(ch.last("job.chunk")); // el job está en vuelo
  ch.inject({ type: "job.cancel", jobId: "jC" });
  await new Promise((r) => setTimeout(r, 10));
  resolveBlock();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(aborted, true, "req.signal debe estar abortado post job.cancel");
  d.stop();
});

test("job.assign con jobId en vuelo → job.fail (no pisa el AbortController)", async () => {
  // Sin el guard, un segundo assign con el mismo jobId reemplazaba el entry
  // del running map: un job.cancel posterior solo abortaba el segundo job.
  let resolveBlock!: () => void;
  const block = new Promise<void>((r) => (resolveBlock = r));
  class Slow extends FakeForgeExec {
    override async *execute(): AsyncIterable<import("@weaver/forge-exec").StreamChunk> {
      yield { token: "t1", done: false };
      await block;
      yield { token: "", done: true };
    }
  }
  const ch = new FakeChannel();
  const d = new ForgeDaemon({ channel: ch, instances: [inst(new Slow({ forgeId: "gpu0", model: "m" }))], sign });
  d.start();
  ch.inject({ type: "job.assign", jobId: "jDUP", instanceId: "gpu0", model: "m", prompt: "p" });
  await new Promise((r) => setTimeout(r, 30));
  ch.inject({ type: "job.assign", jobId: "jDUP", instanceId: "gpu0", model: "m", prompt: "p2" });
  await new Promise((r) => setTimeout(r, 30));
  const fail = ch.sent.filter((m) => m.type === "job.fail").at(-1)!;
  assert.match("error" in fail ? fail.error : "", /ya en vuelo/);
  resolveBlock();
  d.stop();
});

test("S46 rpc-worker: heartbeat lo anuncia con endpoint; proc muerto → saturated", async () => {
  const ch = new FakeChannel();
  const proc = { alive: true };
  const d = new ForgeDaemon({
    channel: ch,
    instances: [
      {
        instanceId: "w0",
        model: "rpc",
        capability: "rpc-worker",
        rpc: { endpoint: "10.0.0.5:50052", vramGb: 24 },
        rpcProc: proc,
        maxConcurrent: 1,
        loadTimeMs: 0,
      },
    ],
    sign,
    heartbeatMs: 10,
  });
  d.start();
  await new Promise((r) => setTimeout(r, 30));
  const w = ch.last("heartbeat")!.instances.find((i) => i.instanceId === "w0")!;
  assert.equal(w.capability, "rpc-worker");
  assert.deepEqual(w.rpc, { endpoint: "10.0.0.5:50052", vramGb: 24 });
  assert.equal(w.saturated, false);
  proc.alive = false;
  await new Promise((r) => setTimeout(r, 30));
  const w2 = ch.last("heartbeat")!.instances.find((i) => i.instanceId === "w0")!;
  assert.equal(w2.hot, false);
  assert.equal(w2.saturated, true); // muerto → el gateway no lo parkea
  d.stop();
});

test("S46 rpc-worker no recibe job.assign → job.fail honesto", async () => {
  const ch = new FakeChannel();
  const d = new ForgeDaemon({
    channel: ch,
    instances: [
      { instanceId: "w0", model: "rpc", capability: "rpc-worker", rpc: { endpoint: "10.0.0.5:1" }, rpcProc: { alive: true }, maxConcurrent: 1, loadTimeMs: 0 },
    ],
    sign,
    heartbeatMs: 60000,
  });
  d.start();
  await new Promise((r) => setTimeout(r, 10));
  ch.inject({ type: "job.assign", jobId: "jW", instanceId: "w0", model: "m", prompt: "p" });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ch.last("job.fail")!.jobId, "jW");
  d.stop();
});

test("S47 stage-worker: heartbeat lo anuncia con layers+endpoint; server muerto → saturated", async () => {
  const ch = new FakeChannel();
  const srv = { alive: true, sessions: 0 };
  const d = new ForgeDaemon({
    channel: ch,
    instances: [
      {
        instanceId: "s0",
        model: "qwen-235b",
        capability: "stage-worker",
        stage: { layers: [0, 40], endpoint: "10.0.0.5:50100", vramGb: 96, tps: 12.5 },
        stageServer: srv,
        maxConcurrent: 1,
        loadTimeMs: 0,
      },
    ],
    sign,
    heartbeatMs: 10,
  });
  d.start();
  await new Promise((r) => setTimeout(r, 30));
  const w = ch.last("heartbeat")!.instances.find((i) => i.instanceId === "s0")!;
  assert.equal(w.capability, "stage-worker");
  assert.deepEqual(w.stage, { layers: [0, 40], endpoint: "10.0.0.5:50100", vramGb: 96, tps: 12.5 });
  assert.equal(w.inFlight, 0); // sessions activas viaja como inFlight
  srv.sessions = 1;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ch.last("heartbeat")!.instances[0].inFlight, 1);
  srv.alive = false;
  await new Promise((r) => setTimeout(r, 30));
  const w2 = ch.last("heartbeat")!.instances.find((i) => i.instanceId === "s0")!;
  assert.equal(w2.hot, false);
  assert.equal(w2.saturated, true);
  d.stop();
});

test("S47 stage-worker no recibe job.assign con prompt → job.fail honesto", async () => {
  const ch = new FakeChannel();
  const d = new ForgeDaemon({
    channel: ch,
    instances: [
      {
        instanceId: "s0",
        model: "qwen-235b",
        capability: "stage-worker",
        stage: { layers: [0, 40], endpoint: "10.0.0.5:50100" },
        stageServer: { alive: true, sessions: 0 },
        maxConcurrent: 1,
        loadTimeMs: 0,
      },
    ],
    sign,
    heartbeatMs: 60000,
  });
  d.start();
  await new Promise((r) => setTimeout(r, 10));
  ch.inject({ type: "job.assign", jobId: "jS", instanceId: "s0", model: "qwen-235b", prompt: "p" });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ch.last("job.fail")!.jobId, "jS");
  d.stop();
});

test("S47 pipeline coordinator: heartbeat declara blocks; stages a no-pipeline → fail", async () => {
  const ch = new FakeChannel();
  const exec = new FakeForgeExec({ forgeId: "c0", model: "qwen-235b" });
  const d = new ForgeDaemon({
    channel: ch,
    instances: [inst(exec, { pipeline: { blocks: 80 } })],
    sign,
    heartbeatMs: 10,
  });
  d.start();
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(ch.last("heartbeat")!.instances[0].pipeline, { blocks: 80 });
  d.stop();

  const ch2 = new FakeChannel();
  const d2 = new ForgeDaemon({
    channel: ch2,
    instances: [inst(new FakeForgeExec({ forgeId: "c1", model: "qwen3:4b" }))], // sin pipeline
    sign,
    heartbeatMs: 60000,
  });
  d2.start();
  await new Promise((r) => setTimeout(r, 10));
  ch2.inject({
    type: "job.assign",
    jobId: "j1",
    instanceId: "c1",
    model: "qwen3:4b",
    prompt: "p",
    stages: [{ endpoint: "10.0.0.5:50100", blocks: [0, 40] }],
  });
  await new Promise((r) => setTimeout(r, 30));
  const f = ch2.last("job.fail")!;
  assert.match(f.error, /no soy pipeline/);
  d2.stop();
});

test("S47 pipeline: instance declarada sin stages en el assign → fail honesto (no hay modelo local completo)", async () => {
  const ch = new FakeChannel();
  const exec = new FakeForgeExec({ forgeId: "c0", model: "qwen-235b" });
  const d = new ForgeDaemon({
    channel: ch,
    instances: [inst(exec, { pipeline: { blocks: 80 } })],
    sign,
    heartbeatMs: 60000,
  });
  d.start();
  await new Promise((r) => setTimeout(r, 10));
  ch.inject({ type: "job.assign", jobId: "j2", instanceId: "c0", model: "qwen-235b", prompt: "p" }); // sin stages
  await new Promise((r) => setTimeout(r, 30));
  const f = ch.last("job.fail")!;
  assert.equal(f.jobId, "j2");
  assert.match(f.error, /pipeline sin stages/);
  d.stop();
});

test("S46 pooled: instance con pool.needs viaja en heartbeat; rpcPeers → pooledFactory", async () => {
  const ch = new FakeChannel();
  const resident = new FakeForgeExec({ forgeId: "c0", model: "qwen-70b" });
  const pooled = new FakeForgeExec({ forgeId: "c0", model: "qwen-70b" });
  const calls: string[][] = [];
  const d = new ForgeDaemon({
    channel: ch,
    instances: [inst(resident, { pool: { needs: 2 } })],
    sign,
    heartbeatMs: 10,
    pooledFactory: (i, peers) => {
      calls.push([i.instanceId, ...peers]);
      return Promise.resolve(pooled);
    },
  });
  d.start();
  await new Promise((r) => setTimeout(r, 30));
  const rep = ch.last("heartbeat")!.instances.find((i) => i.instanceId === "c0")!;
  assert.deepEqual(rep.pool, { needs: 2 });

  ch.inject({ type: "job.assign", jobId: "jP", instanceId: "c0", model: "qwen-70b", prompt: "hi", rpcPeers: ["10.0.0.5:50052", "10.0.0.6:50052"] });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(calls, [["c0", "10.0.0.5:50052", "10.0.0.6:50052"]]);
  assert.equal(ch.last("job.done")!.jobId, "jP"); // el exec pooled sirvió
  d.stop();
});

test("S46 pooled: rpcPeers sin pooledFactory → job.fail honesto; sin peers → exec residente", async () => {
  const ch = new FakeChannel();
  const resident = new FakeForgeExec({ forgeId: "c0", model: "qwen-70b" });
  const d = new ForgeDaemon({
    channel: ch,
    instances: [inst(resident, { pool: { needs: 1 } })],
    sign,
    heartbeatMs: 60000,
  });
  d.start();
  await new Promise((r) => setTimeout(r, 10));
  ch.inject({ type: "job.assign", jobId: "jN", instanceId: "c0", model: "qwen-70b", prompt: "hi", rpcPeers: ["10.0.0.5:50052"] });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ch.last("job.fail")!.jobId, "jN");
  ch.inject({ type: "job.assign", jobId: "jR", instanceId: "c0", model: "qwen-70b", prompt: "hi" });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ch.last("job.done")!.jobId, "jR"); // residente sirvió standalone
  d.stop();
});

test("S46 hardening: rpcPeers a instancia NO pooled → fail (peers no pedidos)", async () => {
  const ch = new FakeChannel();
  const resident = new FakeForgeExec({ forgeId: "c0", model: "qwen-4b" });
  let factoryCalls = 0;
  const d = new ForgeDaemon({
    channel: ch,
    instances: [inst(resident)], // sin pool — nunca pidió workers
    sign,
    heartbeatMs: 60000,
    pooledFactory: () => {
      factoryCalls++;
      return Promise.resolve(new FakeForgeExec({}));
    },
  });
  d.start();
  await new Promise((r) => setTimeout(r, 10));
  ch.inject({ type: "job.assign", jobId: "jX", instanceId: "c0", model: "m", prompt: "p", rpcPeers: ["10.9.9.9:1"] });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ch.last("job.fail")!.jobId, "jX");
  assert.equal(factoryCalls, 0); // el daemon NO obedece peers que no pidió
  d.stop();
});

test("S46 hardening: allowRpcPeers rechaza → fail honesto (gateway no autoridad)", async () => {
  const ch = new FakeChannel();
  const resident = new FakeForgeExec({ forgeId: "c0", model: "qwen-70b" });
  let factoryCalls = 0;
  const d = new ForgeDaemon({
    channel: ch,
    instances: [inst(resident, { pool: { needs: 1 } })],
    sign,
    heartbeatMs: 60000,
    allowRpcPeers: (peers) => peers.every((p) => p.startsWith("192.168.")),
    pooledFactory: () => {
      factoryCalls++;
      return Promise.resolve(new FakeForgeExec({}));
    },
  });
  d.start();
  await new Promise((r) => setTimeout(r, 10));
  ch.inject({ type: "job.assign", jobId: "jD", instanceId: "c0", model: "m", prompt: "p", rpcPeers: ["8.8.8.8:50052"] });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ch.last("job.fail")!.jobId, "jD");
  assert.equal(factoryCalls, 0); // allowlist operador ganó sobre el assign
  ch.inject({ type: "job.assign", jobId: "jO", instanceId: "c0", model: "m", prompt: "p", rpcPeers: ["192.168.1.7:50052"] });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(factoryCalls, 1); // dentro de la allowlist → pooled sirve
  d.stop();
});

test("S46 hardening: pooledFactory lanza → job.fail con poolBlame (culpa a los peers)", async () => {
  const ch = new FakeChannel();
  const resident = new FakeForgeExec({ forgeId: "c0", model: "qwen-70b" });
  const d = new ForgeDaemon({
    channel: ch,
    instances: [inst(resident, { pool: { needs: 1 } })],
    sign,
    heartbeatMs: 60000,
    pooledFactory: () => Promise.reject(new Error("llama-server murió al boot")),
  });
  d.start();
  await new Promise((r) => setTimeout(r, 10));
  ch.inject({ type: "job.assign", jobId: "jB", instanceId: "c0", model: "m", prompt: "p", rpcPeers: ["10.0.0.5:50052"] });
  await new Promise((r) => setTimeout(r, 30));
  const f = ch.last("job.fail")!;
  assert.equal(f.jobId, "jB");
  assert.equal(f.poolBlame, true); // el gateway penaliza a LOS PEERS
  d.stop();
});

test("S46 hardening: job.cancel DURANTE spawn pooled → fail, no sirve al muerto", async () => {
  const ch = new FakeChannel();
  const resident = new FakeForgeExec({ forgeId: "c0", model: "qwen-70b" });
  let releaseSpawn!: () => void;
  const spawnGate = new Promise<ForgeExec>((res) => {
    releaseSpawn = () => res(new FakeForgeExec({}));
  });
  let sawSignal = false;
  const d = new ForgeDaemon({
    channel: ch,
    instances: [inst(resident, { pool: { needs: 1 } })],
    sign,
    heartbeatMs: 60000,
    pooledFactory: (_i, _peers, signal) => {
      signal?.addEventListener("abort", () => {
        sawSignal = true;
      });
      return spawnGate; // boot lento — como un llama-server de 70B
    },
  });
  d.start();
  await new Promise((r) => setTimeout(r, 10));
  ch.inject({ type: "job.assign", jobId: "jC", instanceId: "c0", model: "m", prompt: "p", rpcPeers: ["10.0.0.5:50052"] });
  await new Promise((r) => setTimeout(r, 20));
  ch.inject({ type: "job.cancel", jobId: "jC" }); // el consumidor se fue mid-boot
  await new Promise((r) => setTimeout(r, 20));
  releaseSpawn(); // el server levanta — pero el job ya murió
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ch.last("job.fail")!.jobId, "jC");
  assert.equal(sawSignal, true); // la factory recibió el signal para matar el spawn
  assert.equal(ch.last("job.chunk"), undefined); // jamás se sirvió un token
  d.stop();
});

test("S46 hardening: daemon.stop() → dispose de la factory (warm servers mueren)", async () => {
  const ch = new FakeChannel();
  const resident = new FakeForgeExec({ forgeId: "c0", model: "qwen-70b" });
  let disposed = 0;
  const factory = Object.assign(
    () => Promise.resolve(new FakeForgeExec({})),
    {
      dispose: () => {
        disposed++;
      },
    },
  );
  const d = new ForgeDaemon({
    channel: ch,
    instances: [inst(resident, { pool: { needs: 1 } })],
    sign,
    heartbeatMs: 60000,
    pooledFactory: factory,
  });
  d.start();
  await new Promise((r) => setTimeout(r, 10));
  d.stop();
  assert.equal(disposed, 1); // los llama-server warm no quedan colgados en VRAM
});

test("S46 hardening: rpcProbe caído → worker reporta muerto aunque el proc viva", async () => {
  const ch = new FakeChannel();
  const d = new ForgeDaemon({
    channel: ch,
    instances: [
      {
        instanceId: "w0",
        model: "rpc",
        capability: "rpc-worker",
        rpc: { endpoint: "10.0.0.5:50052" },
        rpcProc: { alive: true },
        rpcProbe: async () => false, // proceso vivo PERO endpoint no alcanzable
        maxConcurrent: 1,
        loadTimeMs: 0,
      },
    ],
    sign,
    heartbeatMs: 10,
  });
  d.start();
  await new Promise((r) => setTimeout(r, 30));
  const w = ch.last("heartbeat")!.instances.find((i) => i.instanceId === "w0")!;
  assert.equal(w.saturated, true); // live:false para el gateway — endpoint muerto
  d.stop();
});

test("job.assign a instanceId desconocido → job.fail (no cuelga el gateway)", async () => {
  const ch = new FakeChannel();
  const d = new ForgeDaemon({ channel: ch, instances: [inst(new FakeForgeExec({ forgeId: "gpu0" }))], sign });
  d.start();
  ch.inject({ type: "job.assign", jobId: "jX", instanceId: "nope", model: "m", prompt: "p" });
  await new Promise((r) => setTimeout(r, 30));
  const fail = ch.last("job.fail")!;
  assert.equal(fail.jobId, "jX");
  assert.equal(fail.midStream, false);
  d.stop();
});

test("exec que lanza pre-token → job.fail midStream:false (reintentable)", async () => {
  class Boom extends FakeForgeExec {
    override async *execute(): AsyncIterable<never> {
      throw new Error("engine caído");
    }
  }
  const ch = new FakeChannel();
  const d = new ForgeDaemon({ channel: ch, instances: [inst(new Boom({ forgeId: "gpu0" }))], sign });
  d.start();
  ch.inject({ type: "job.assign", jobId: "jB", instanceId: "gpu0", model: "qwen3:4b", prompt: "p" });
  await new Promise((r) => setTimeout(r, 30));
  const fail = ch.last("job.fail")!;
  assert.match(fail.error, /engine caído/);
  assert.equal(fail.midStream, false);
  d.stop();
});

test("toolCalls del engine viajan en job.done (multi-hop remoto)", async () => {
  class ToolExec extends FakeForgeExec {
    override async *execute(): AsyncIterable<{ token: string; done: boolean; toolCalls?: { name: string; arguments: Record<string, unknown> }[] }> {
      yield { token: "", done: true, toolCalls: [{ name: "web_search", arguments: { q: "x" } }] };
    }
  }
  const ch = new FakeChannel();
  const d = new ForgeDaemon({ channel: ch, instances: [inst(new ToolExec({ forgeId: "gpu0" }))], sign });
  d.start();
  ch.inject({ type: "job.assign", jobId: "jT", instanceId: "gpu0", model: "qwen3:4b", prompt: "p" });
  await new Promise((r) => setTimeout(r, 30));
  const done = ch.last("job.done")!;
  assert.equal(done.toolCalls?.[0]?.name, "web_search");
  d.stop();
});

test("idleOnly + usuario activo → todas las instances saturadas (no muertas)", async () => {
  const ch = new FakeChannel();
  const d = new ForgeDaemon({
    channel: ch,
    instances: [inst(new FakeForgeExec({ forgeId: "gpu0" }))],
    sign,
    heartbeatMs: 10,
    budgets: { idleOnly: true, idleThresholdMs: 60_000 },
    probes: { idleMs: async () => 5_000 }, // 5s de idle < 60s → usuario activo
  });
  d.start();
  await new Promise((r) => setTimeout(r, 30));
  const hb = ch.last("heartbeat")!;
  assert.equal(hb.instances[0].saturated, true);
  assert.equal(hb.instances[0].hot, true); // existe y está caliente — no miente
  d.stop();
});

test("idleOnly + idle no medible → conservador: saturated", async () => {
  const ch = new FakeChannel();
  const d = new ForgeDaemon({
    channel: ch,
    instances: [inst(new FakeForgeExec({ forgeId: "gpu0" }))],
    sign,
    heartbeatMs: 10,
    budgets: { idleOnly: true },
    probes: { idleMs: async () => null },
  });
  d.start();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ch.last("heartbeat")!.instances[0].saturated, true);
  d.stop();
});

test("maxVramGb: COLD sobre budget → saturated; HOT siempre se ofrece", async () => {
  class ColdExec extends FakeForgeExec {
    async resident(): Promise<boolean> {
      return false;
    }
  }
  const ch = new FakeChannel();
  const d = new ForgeDaemon({
    channel: ch,
    instances: [
      inst(new ColdExec({ forgeId: "fria", model: "qwen3:8b" }), { vramGb: 5 }),
      inst(new FakeForgeExec({ forgeId: "caliente" }), { vramGb: 5 }),
    ],
    sign,
    heartbeatMs: 10,
    budgets: { maxVramGb: 10 },
    probes: { vramUsedGb: async () => 6 }, // 6 + 5 > 10 → la fría no entra
  });
  d.start();
  await new Promise((r) => setTimeout(r, 30));
  const hb = ch.last("heartbeat")!;
  assert.equal(hb.instances.find((i) => i.instanceId === "fria")!.saturated, true);
  assert.equal(hb.instances.find((i) => i.instanceId === "caliente")!.saturated, false);
  d.stop();
});

test("image.assign → image.result con b64+ms", async () => {
  const imgExec = {
    forgeId: "img0",
    model: "flux2-klein-4b",
    generateImage: async () => ({ forgeId: "img0", b64: "aGk=", ms: 900 }),
  };
  const ch = new FakeChannel();
  const d = new ForgeDaemon({
    channel: ch,
    instances: [inst(imgExec, { instanceId: "img0", model: "flux2-klein-4b", capability: "image" })],
    sign,
  });
  d.start();
  ch.inject({ type: "image.assign", jobId: "jI", instanceId: "img0", model: "flux2-klein-4b", prompt: "gato" });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(ch.last("image.result"), { type: "image.result", jobId: "jI", b64: "aGk=", ms: 900 });
  d.stop();
});

test("image.assign en vuelo: job.cancel y canal muerto abortan el exec", async () => {
  let sawAbort = false;
  const imgExec = {
    forgeId: "img0",
    model: "flux2-klein-4b",
    generateImage: (req: { signal?: AbortSignal }) =>
      new Promise<{ forgeId: string; b64: string; ms: number }>((_res, rej) => {
        req.signal?.addEventListener("abort", () => {
          sawAbort = true;
          rej(new Error("aborted"));
        });
      }),
  };
  const ch = new FakeChannel();
  const d = new ForgeDaemon({
    channel: ch,
    instances: [inst(imgExec, { instanceId: "img0", capability: "image" })],
    sign,
  });
  d.start();
  ch.inject({ type: "image.assign", jobId: "jI", instanceId: "img0", model: "flux2-klein-4b", prompt: "gato" });
  await new Promise((r) => setTimeout(r, 20));
  ch.inject({ type: "job.cancel", jobId: "jI" });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sawAbort, true, "job.cancel debe llegar al engine de imagen");
  assert.ok(ch.last("job.fail"), "el job abortado reporta fail (no queda mudo)");
  assert.equal(ch.last("image.result"), undefined);

  // Y lo mismo cuando el CANAL muere (kill/drop): sin abort el engine seguiría
  // generando una imagen que nadie puede recibir.
  sawAbort = false;
  const ch2 = new FakeChannel();
  const d2 = new ForgeDaemon({
    channel: ch2,
    instances: [inst(imgExec, { instanceId: "img0", capability: "image" })],
    sign,
  });
  d2.start();
  ch2.inject({ type: "image.assign", jobId: "jI2", instanceId: "img0", model: "flux2-klein-4b", prompt: "gato" });
  await new Promise((r) => setTimeout(r, 20));
  ch2.close();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sawAbort, true, "canal muerto debe abortar el engine de imagen");
  d2.stop();
  d.stop();
});

test("S42: job.funded → self-claim con la firma re-hecha del resultHash", async () => {
  const ch = new FakeChannel();
  const claimed: { jobId: number; hash: Buffer; sig: Buffer }[] = [];
  const d = new ForgeDaemon({
    channel: ch,
    instances: [inst(new FakeForgeExec({ forgeId: "i1" }))],
    sign,
    claim: async (chainJobId, resultHash, forgeSig) => {
      claimed.push({ jobId: chainJobId, hash: resultHash, sig: forgeSig });
      return "claim-tx";
    },
  });
  d.start();
  const hash = createHash("sha256").update("output-real").digest();
  ch.inject({ type: "job.funded", chainJobId: 42, resultHash: hash.toString("hex") });
  await new Promise((r) => setImmediate(r));
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].jobId, 42);
  assert.deepEqual(claimed[0].hash, hash);
  assert.deepEqual(claimed[0].sig, sign(hash)); // firma re-derivada, no replayed
  d.stop();
});

test("S42: job.funded sin claimer configurado → no crashea, solo loguea", async () => {
  const ch = new FakeChannel();
  const d = new ForgeDaemon({ channel: ch, instances: [inst(new FakeForgeExec({ forgeId: "i1" }))], sign });
  d.start();
  ch.inject({ type: "job.funded", chainJobId: 7, resultHash: "aa".repeat(32) });
  await new Promise((r) => setImmediate(r));
  d.stop(); // sin throw = ok
});

test("S47 heal: requestStage del exec → stage.need al gateway → stage.offer resuelve", async () => {
  const ch = new FakeChannel();
  // Exec que pide un reemplazo ni bien arranca — el test observa el need y
  // responde el offer por el mismo canal (como lo haría el gateway real).
  const exec: ForgeExec = {
    forgeId: "c0",
    model: "qwen-235b",
    async *execute(req) {
      const offer = await captured!("10.0.0.5:50100", [0, 40]);
      yield { token: `rep:${offer?.endpoint ?? "none"}`, done: false };
      yield { token: "", done: true };
    },
  };
  let captured: ((dead: string, blocks: [number, number]) => Promise<{ endpoint?: string; blocks?: [number, number] }>) | undefined;
  const d = new ForgeDaemon({
    channel: ch,
    instances: [inst(exec, { pipeline: { blocks: 80 } })],
    sign,
    heartbeatMs: 60000,
    pipelineFactory: (_i, _stages, _signal, requestStage) => {
      captured = requestStage;
      return Promise.resolve(exec);
    },
  });
  d.start();
  await new Promise((r) => setTimeout(r, 10));
  ch.inject({
    type: "job.assign",
    jobId: "jH",
    instanceId: "c0",
    model: "qwen-235b",
    prompt: "p",
    stages: [{ endpoint: "10.0.0.5:50100", blocks: [0, 40] }],
  });
  await new Promise((r) => setTimeout(r, 30));
  // El daemon emitió stage.need al gateway con el tramo del muerto.
  const need = ch.last("stage.need")!;
  assert.equal(need.jobId, "jH");
  assert.equal(need.dead, "10.0.0.5:50100");
  assert.deepEqual(need.blocks, [0, 40]);
  // El gateway responde con un reemplazo → el exec lo recibe.
  ch.inject({ type: "stage.offer", jobId: "jH", endpoint: "10.0.0.9:50100", blocks: [0, 40] });
  await new Promise((r) => setTimeout(r, 30));
  assert.match(ch.last("job.chunk")!.token, /rep:10\.0\.0\.9:50100/);
  assert.ok(ch.last("job.done"));
  d.stop();
});

test("S47 heal: stage.offer sin need pendiente → ignorado (no throw)", async () => {
  const ch = new FakeChannel();
  const d = new ForgeDaemon({
    channel: ch,
    instances: [inst(new FakeForgeExec({ forgeId: "c0" }), { pipeline: { blocks: 80 } })],
    sign,
    heartbeatMs: 60000,
    pipelineFactory: () => Promise.resolve(new FakeForgeExec({ forgeId: "c0" })),
  });
  d.start();
  await new Promise((r) => setTimeout(r, 10));
  ch.inject({ type: "stage.offer", jobId: "inexistente", endpoint: "10.0.0.9:1", blocks: [0, 8] });
  await new Promise((r) => setTimeout(r, 20));
  d.stop(); // sin crash = ok
});
