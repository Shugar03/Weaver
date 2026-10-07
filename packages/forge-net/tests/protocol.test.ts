// S30 — codec del protocolo: validación estricta, null jamás throw.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decode, decodeGateway, encode, type InstanceReport } from "../src/protocol.ts";

describe("S30 protocol decode (daemon→gateway)", () => {
  it("heartbeat válido roundtrip", () => {
    const msg = {
      type: "heartbeat" as const,
      instances: [
        { instanceId: "i0", model: "m", capability: "text" as const, hot: true, inFlight: 2, saturated: false, loadTimeMs: 100, tokPerSec: 42.5 },
      ],
    };
    const d = decode(encode(msg));
    assert.deepEqual(d, msg);
  });

  it("auth / job.chunk / job.done / job.fail / image.result / pong", () => {
    const cases = [
      { type: "auth", pubkey: "G", nonce: "n", signature: "ab" },
      { type: "job.ack", jobId: "j" },
      { type: "job.chunk", jobId: "j", token: "hola", kind: "think" },
      { type: "job.done", jobId: "j", resultHash: "aa", signature: "bb", stats: { genTokens: 5 } },
      { type: "job.fail", jobId: "j", error: "boom", midStream: false },
      { type: "image.result", jobId: "j", b64: "AAAA", ms: 15000 },
      { type: "pong", t: 123 },
    ];
    for (const c of cases) assert.deepEqual(decode(encode(c as never)), c);
  });

  it("malformado → null (nunca throw al proceso)", () => {
    assert.equal(decode("no json"), null);
    assert.equal(decode("{}"), null);
    assert.equal(decode('{"type":"heartbeat","instances":[{"bad":1}]}'), null);
    assert.equal(decode('{"type":"auth","pubkey":"G"}'), null); // falta nonce/sig
    assert.equal(decode('{"type":"job.chunk","jobId":"j","token":42}'), null);
    assert.equal(decode('{"type":"desconocido"}'), null);
    assert.equal(decode('{"type":"heartbeat","instances":"x"}'), null);
  });
});

describe("S30 protocol decodeGateway (gateway→daemon)", () => {
  it("job.assign / image.assign / ping / auth.ok / auth.fail", () => {
    const cases = [
      { type: "job.assign", jobId: "j", instanceId: "i", model: "m", prompt: "p", options: { maxTokens: 5 } },
      { type: "image.assign", jobId: "j", instanceId: "i", model: "m", prompt: "p", size: "1024x1024" },
      { type: "ping", t: 1 },
      { type: "auth.ok", pubkey: "G" },
      { type: "auth.fail", error: "firma inválida" },
    ];
    for (const c of cases) assert.deepEqual(decodeGateway(encode(c as never)), c);
  });

  it("assign malformado → null", () => {
    assert.equal(decodeGateway('{"type":"job.assign","jobId":"j"}'), null);
    assert.equal(decodeGateway("{{"), null);
  });
});

describe("P0-4 heartbeat bounds (anti-amplificación)", () => {
  const inst = (over: Record<string, unknown> = {}) => ({
    instanceId: "i0",
    model: "qwen3.5:4b",
    capability: "text",
    hot: true,
    inFlight: 0,
    saturated: false,
    loadTimeMs: 100,
    ...over,
  });
  const hb = (instances: unknown[]) =>
    decode(JSON.stringify({ type: "heartbeat", instances }));

  it("17+ instances → null: un daemon es UNA máquina, no 10k slots", () => {
    // Cada instance dispara una attestation real en el gateway — sin cap un
    // heartbeat forjado amplificaba jobs gratis contra la fleet.
    assert.notEqual(hb(Array.from({ length: 16 }, (_, i) => inst({ instanceId: `i${i}` }))), null);
    assert.equal(hb(Array.from({ length: 17 }, (_, i) => inst({ instanceId: `i${i}` }))), null);
  });

  it("strings acotados: instanceId/model vacíos o >128 → null", () => {
    assert.equal(hb([inst({ instanceId: "" })]), null);
    assert.equal(hb([inst({ instanceId: "x".repeat(129) })]), null);
    assert.equal(hb([inst({ model: "" })]), null);
    assert.equal(hb([inst({ model: "m".repeat(129) })]), null);
    assert.notEqual(hb([inst({ instanceId: "x".repeat(128) })]), null);
  });

  it("numéricos que gaman el scheduler → null", () => {
    // El registry confía estos números al scheduler/ETR: negativos o absurdos
    // sesgaban selección y billing.
    assert.equal(hb([inst({ inFlight: -1 })]), null);
    assert.equal(hb([inst({ inFlight: 2048 })]), null);
    assert.equal(hb([inst({ loadTimeMs: -1 })]), null);
    assert.equal(hb([inst({ loadTimeMs: 3_600_000 })]), null);
    assert.equal(hb([inst({ tokPerSec: -5 })]), null);
    assert.equal(hb([inst({ tokPerSec: 1e9 })]), null);
    assert.equal(hb([inst({ price: -1 })]), null);
    assert.equal(hb([inst({ price: 1e9 })]), null);
  });
});

describe("S46 pool-forge: rpc-worker + rpcPeers (spec 017)", () => {
  const worker = (over: Record<string, unknown> = {}) => ({
    instanceId: "w0",
    model: "rpc",
    capability: "rpc-worker",
    hot: true,
    inFlight: 0,
    saturated: false,
    loadTimeMs: 0,
    rpc: { endpoint: "192.168.1.10:50052", vramGb: 24 },
    ...over,
  });
  const hb = (instances: unknown[]) =>
    decode(JSON.stringify({ type: "heartbeat", instances }));

  it("rpc-worker válido roundtrip — endpoint + vramGb viajan", () => {
    const d = hb([worker()]);
    assert.notEqual(d, null);
    const i = (d as { instances: InstanceReport[] }).instances[0];
    assert.equal(i.capability, "rpc-worker");
    assert.deepEqual(i.rpc, { endpoint: "192.168.1.10:50052", vramGb: 24 });
  });

  it("rpc-worker sin endpoint o endpoint malformado → null", () => {
    assert.equal(hb([worker({ rpc: undefined })]), null);
    assert.equal(hb([worker({ rpc: { endpoint: "sin puerto" } })]), null);
    assert.equal(hb([worker({ rpc: { endpoint: "host:notaport" } })]), null);
    assert.equal(hb([worker({ rpc: { endpoint: "h o s t:1" } })]), null);
    assert.equal(hb([worker({ rpc: { endpoint: "x".repeat(254) + ":1" } })]), null);
    assert.equal(hb([worker({ rpc: { endpoint: "10.0.0.1:70000" } })]), null);
  });

  it("capability text con pool.needs válido roundtrip", () => {
    const d = hb([{ instanceId: "i0", model: "qwen-70b", capability: "text", hot: true, inFlight: 0, saturated: false, loadTimeMs: 3000, pool: { needs: 2 } }]);
    const i = (d as { instances: InstanceReport[] }).instances[0];
    assert.deepEqual(i.pool, { needs: 2 });
  });

  it("pool.needs fuera de rango → null (1-4 stages, no enjambre infinito)", () => {
    const base = { instanceId: "i0", model: "m", capability: "text", hot: true, inFlight: 0, saturated: false, loadTimeMs: 1 };
    assert.equal(hb([{ ...base, pool: { needs: 0 } }]), null);
    assert.equal(hb([{ ...base, pool: { needs: 5 } }]), null);
    assert.equal(hb([{ ...base, pool: { needs: 1.5 } }]), null);
    assert.notEqual(hb([{ ...base, pool: { needs: 1 } }]), null);
  });

  it("job.assign con rpcPeers decodes; peers inválidos → null", () => {
    const ok = decodeGateway(JSON.stringify({ type: "job.assign", jobId: "j", instanceId: "i", model: "m", prompt: "p", rpcPeers: ["10.0.0.1:50052", "10.0.0.2:50052"] }));
    assert.deepEqual((ok as { rpcPeers?: string[] }).rpcPeers, ["10.0.0.1:50052", "10.0.0.2:50052"]);
    assert.equal(decodeGateway(JSON.stringify({ type: "job.assign", jobId: "j", instanceId: "i", model: "m", prompt: "p", rpcPeers: ["a:1", "b:2", "c:3", "d:4", "e:5"] })), null);
    assert.equal(decodeGateway(JSON.stringify({ type: "job.assign", jobId: "j", instanceId: "i", model: "m", prompt: "p", rpcPeers: [42] })), null);
  });
});
