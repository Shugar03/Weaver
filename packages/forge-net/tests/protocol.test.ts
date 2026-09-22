// S30 — codec del protocolo: validación estricta, null jamás throw.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decode, decodeGateway, encode } from "../src/protocol.ts";

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
