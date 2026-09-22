// S33 — ForgeDaemon (lado daemon del protocolo): heartbeat con capacidad
// MEDIDA local, dispatch de job.assign/image.assign a los execs locales,
// proof L0 firmado con la keypair del forge. Canal falso — sin sockets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { FakeForgeExec, TrackedExec } from "@weaver/forge-exec";
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

function inst(exec: DaemonInstance["exec"], over: Partial<DaemonInstance> = {}): DaemonInstance {
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
  const expectHash = createHash("sha256").update("echo:hola", "utf8").digest();
  assert.equal(done.resultHash, expectHash.toString("hex"));
  assert.equal(done.signature, sign(expectHash).toString("hex"));
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
