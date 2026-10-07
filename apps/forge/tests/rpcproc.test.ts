// S46 rpcproc — ciclo de vida de procesos llama.cpp (hardening CTO):
// LRU acotado con kill al evictar, server muerto → respawn, spawn args
// correctos, health-check que decide boot.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { makePooledFactory } from "../src/rpcproc.ts";
import type { DaemonInstance } from "../src/daemon.ts";

// ChildProcess fake: emite 'exit' manualmente, registra kill.
class FakeProc extends EventEmitter {
  killed = false;
  exitCode: number | null = null;
  kill(sig?: string): boolean {
    this.killed = true;
    queueMicrotask(() => this.emit("exit", 9));
    return true;
  }
}

const inst = (over: Partial<DaemonInstance> = {}): DaemonInstance => ({
  instanceId: "c0",
  model: "qwen-70b",
  capability: "text",
  maxConcurrent: 1,
  loadTimeMs: 0,
  pool: { needs: 2 },
  modelFile: "/models/qwen.gguf",
  ...over,
});

const factory = (over: Record<string, unknown> = {}, spawned?: { args: string[][]; procs: FakeProc[] }) =>
  makePooledFactory({
    llamaBin: "/bin/llama-server",
    healthProbe: async () => {}, // boot instantáneo en tests
    ...over,
    spawn: ((bin: string, args: string[]) => {
      const p = new FakeProc();
      spawned?.args.push(args);
      spawned?.procs.push(p);
      return p as unknown as ChildProcess;
    }) as typeof import("node:child_process").spawn,
  });

describe("makePooledFactory hardening", () => {
  it("spawn con args correctos: --rpc peers, --split-mode layer, --port", async () => {
    const spawned = { args: [] as string[][], procs: [] as FakeProc[] };
    const f = factory({}, spawned);
    await f(inst(), ["10.0.0.1:50052", "10.0.0.2:50052"]);
    assert.equal(spawned.args.length, 1);
    const a = spawned.args[0];
    assert.deepEqual([a[0], a[1]], ["-m", "/models/qwen.gguf"]);
    assert.ok(a.includes("--rpc"));
    assert.equal(a[a.indexOf("--rpc") + 1], "10.0.0.1:50052,10.0.0.2:50052");
    assert.ok(a.includes("--split-mode") && a.includes("layer"));
    assert.ok(a.includes("--port")); // no -p (ese es del rpc-server)
  });

  it("mismo peer-set → REUSA el warm server (no respawnea por job)", async () => {
    const spawned = { args: [] as string[][], procs: [] as FakeProc[] };
    const f = factory({}, spawned);
    await f(inst(), ["10.0.0.1:50052"]);
    await f(inst(), ["10.0.0.1:50052"]);
    assert.equal(spawned.args.length, 1); // un server, dos jobs
  });

  it("server warm muerto → respawn, no adapter contra puerto cadáver", async () => {
    const spawned = { args: [] as string[][], procs: [] as FakeProc[] };
    const f = factory({}, spawned);
    await f(inst(), ["10.0.0.1:50052"]);
    spawned.procs[0].emit("exit", 1); // el llama-server murió
    await f(inst(), ["10.0.0.1:50052"]);
    assert.equal(spawned.args.length, 2); // respawneó — no sirvió el cadáver
  });

  it("LRU acotado: al superar maxWarm mata el entry menos usado", async () => {
    const spawned = { args: [] as string[][], procs: [] as FakeProc[] };
    const f = factory({ maxWarm: 2 }, spawned);
    await f(inst(), ["10.0.0.1:50052"]);
    await f(inst(), ["10.0.0.2:50052"]);
    await f(inst(), ["10.0.0.3:50052"]); // 3er peer-set → evicta el 1ro
    await new Promise((r) => setTimeout(r, 20)); // evict async
    assert.equal(spawned.procs.length, 3);
    assert.equal(spawned.procs[0].killed, true); // el LRU murió con SIGKILL
    assert.equal(spawned.procs[1].killed, false);
    assert.equal(spawned.procs[2].killed, false);
  });

  it("sin modelFile → error honesto (no spawnea nada)", async () => {
    const spawned = { args: [] as string[][], procs: [] as FakeProc[] };
    const f = factory({}, spawned);
    await assert.rejects(() => f(inst({ modelFile: undefined }), ["10.0.0.1:50052"]), /modelFile/);
    assert.equal(spawned.args.length, 0);
  });

  it("healthProbe rechaza → error + el proceso muere (sin zombie de boot)", async () => {
    const spawned = { args: [] as string[][], procs: [] as FakeProc[] };
    const f = factory({ healthProbe: async () => { throw new Error("health timeout"); } }, spawned);
    await assert.rejects(() => f(inst(), ["10.0.0.1:50052"]), /health timeout/);
    assert.equal(spawned.procs[0].killed, true); // boot fallido → kill, no zombie
    // y NO quedó cacheado: reintento spawnea de nuevo
    await assert.rejects(() => f(inst(), ["10.0.0.1:50052"]));
    assert.equal(spawned.args.length, 2);
  });
});
