// S47 — codec stage-federation forge↔forge (spec 018): validación estricta.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decodeCoord, decodeStage, encode } from "../src/stageproto.ts";

describe("S47 stageproto coord→stage", () => {
  it("stage.open / step / close roundtrip", () => {
    const open = { type: "stage.open" as const, jobId: "j1", sessionId: "s1", model: "qwen-235b", blocks: [0, 40] as [number, number], kvLenHint: 2048 };
    assert.deepEqual(decodeCoord(encode(open)), open);
    const step = { type: "stage.step" as const, sessionId: "s1", seq: 3, shape: [1, 8192] as [number, number], dtype: "f16" as const, payload: "AAAA" };
    assert.deepEqual(decodeCoord(encode(step)), step);
    const close = { type: "stage.close" as const, sessionId: "s1" };
    assert.deepEqual(decodeCoord(encode(close)), close);
  });

  it("malformados → null: bloques inválidos, seq negativo, shape feo, payload gigante, dtype desconocido", () => {
    assert.equal(decodeCoord('{"type":"stage.open","jobId":"j","sessionId":"s","model":"m","blocks":[40,20]}'), null);
    assert.equal(decodeCoord('{"type":"stage.open","jobId":"j","sessionId":"s","model":"m","blocks":[0,999]}'), null);
    assert.equal(decodeCoord('{"type":"stage.step","sessionId":"s","seq":-1,"shape":[1,8],"dtype":"f16","payload":"AA"}'), null);
    assert.equal(decodeCoord('{"type":"stage.step","sessionId":"s","seq":0,"shape":[0,8],"dtype":"f16","payload":"AA"}'), null);
    assert.equal(decodeCoord(`{"type":"stage.step","sessionId":"s","seq":0,"shape":[1,8],"dtype":"f16","payload":"${"A".repeat(6_000_001)}"}`), null);
    assert.equal(decodeCoord('{"type":"stage.step","sessionId":"s","seq":0,"shape":[1,8],"dtype":"f64","payload":"AA"}'), null);
    assert.equal(decodeCoord('{"type":"stage.step","sessionId":"s","seq":0,"shape":[1,8],"dtype":"f16","payload":"***"}'), null);
    assert.equal(decodeCoord("no json"), null);
    assert.equal(decodeCoord('{"type":"desconocido"}'), null);
  });
});

describe("S47 stageproto stage→coord", () => {
  it("stage.ack / out / fail roundtrip", () => {
    const ack = { type: "stage.ack" as const, sessionId: "s1" };
    assert.deepEqual(decodeStage(encode(ack)), ack);
    const out = { type: "stage.out" as const, sessionId: "s1", seq: 7, payload: "BBBB", sig: "ab12" };
    assert.deepEqual(decodeStage(encode(out)), out);
    const outSinSig = { type: "stage.out" as const, sessionId: "s1", seq: 7, payload: "BBBB" };
    assert.deepEqual(decodeStage(encode(outSinSig)), outSinSig);
    const fail = { type: "stage.fail" as const, sessionId: "s1", error: "oom" };
    assert.deepEqual(decodeStage(encode(fail)), fail);
  });

  it("malformados → null: seq no-entero, payload vacío ok pero sig >256 no", () => {
    assert.equal(decodeStage('{"type":"stage.out","sessionId":"s","seq":1.5,"payload":"AA"}'), null);
    assert.equal(decodeStage(`{"type":"stage.out","sessionId":"s","seq":0,"payload":"AA","sig":"${"x".repeat(257)}"}`), null);
    assert.equal(decodeStage('{"type":"stage.fail","sessionId":"s"}'), null);
  });
});
