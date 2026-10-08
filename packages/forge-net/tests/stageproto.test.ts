// S47 — codec stage-federation forge↔forge (spec 018): validación estricta.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { decodeCoord, decodeStage, encode, stageChainInit, stageChainStep, stageHalfInit, stageHalfStep, stageSigPreimage, stageSigPreimageV2, stageToken, stageTokenOk } from "../src/stageproto.ts";

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

  it("B1: open con token/coordPubkey roundtrip + bounds", () => {
    const tok = "ab".repeat(32);
    const open = { type: "stage.open" as const, jobId: "j1", sessionId: "s1", model: "m", blocks: [0, 12] as [number, number], token: tok, coordPubkey: "GABC" };
    assert.deepEqual(decodeCoord(encode(open)), open);
    // sin auth (modo lab) sigue decodificando
    assert.equal(decodeCoord('{"type":"stage.open","jobId":"j","sessionId":"s","model":"m","blocks":[0,12]}')?.type, "stage.open");
    // bounds: token >256 y coordPubkey >128 → frame inválido entero
    assert.equal(decodeCoord(`{"type":"stage.open","jobId":"j","sessionId":"s","model":"m","blocks":[0,12],"token":"${"x".repeat(257)}"}`), null);
    assert.equal(decodeCoord(`{"type":"stage.open","jobId":"j","sessionId":"s","model":"m","blocks":[0,12],"coordPubkey":"${"x".repeat(129)}"}`), null);
    assert.equal(decodeCoord('{"type":"stage.open","jobId":"j","sessionId":"s","model":"m","blocks":[0,12],"token":42}'), null);
  });

  it("B2: open con next-hop (endpoint+sessionId+creds) roundtrip + bounds", () => {
    const open = {
      type: "stage.open" as const, jobId: "j1", sessionId: "j1:s0", model: "m", blocks: [0, 12] as [number, number],
      token: "ab".repeat(32), coordPubkey: "GC",
      next: { endpoint: "1.2.3.4:9000", sessionId: "j1:s1", token: "cd".repeat(32), coordPubkey: "GC" },
    };
    assert.deepEqual(decodeCoord(encode(open)), open);
    // next malformado → frame entero inválido
    assert.equal(decodeCoord('{"type":"stage.open","jobId":"j","sessionId":"s","model":"m","blocks":[0,12],"next":{"endpoint":"","sessionId":"x"}}'), null);
    assert.equal(decodeCoord(`{"type":"stage.open","jobId":"j","sessionId":"s","model":"m","blocks":[0,12],"next":{"endpoint":"${"x".repeat(300)}","sessionId":"x"}}`), null);
    assert.equal(decodeCoord(`{"type":"stage.open","jobId":"j","sessionId":"s","model":"m","blocks":[0,12],"next":{"endpoint":"1.2.3.4:9","sessionId":"x","token":"${"x".repeat(257)}"}}`), null);
  });

  it("B2: stage.fwd (data plane directo) roundtrip + validación", () => {
    const fwd = {
      type: "stage.fwd" as const, sessionId: "j1:s1", seq: 4,
      shape: [1, 896] as [number, number], dtype: "f16" as const, payload: "AA==",
      token: "ab".repeat(32), coordPubkey: "GC",
    };
    assert.deepEqual(decodeCoord(encode(fwd)), fwd);
    // credenciales opcionales (lab mode), pero si están: acotadas
    const bare = { type: "stage.fwd" as const, sessionId: "j1:s1", seq: 0, shape: [1, 8] as [number, number], dtype: "f32" as const, payload: "AA==" };
    assert.deepEqual(decodeCoord(encode(bare)), bare);
    assert.equal(decodeCoord('{"type":"stage.fwd","sessionId":"s","seq":0,"shape":[1,8],"dtype":"f16","payload":"AA==","token":42}'), null);
    assert.equal(decodeCoord(`{"type":"stage.fwd","sessionId":"s","seq":0,"shape":[1,8],"dtype":"f16","payload":"AA==","token":"${"x".repeat(257)}"}`), null);
    // mismos bounds que step
    assert.equal(decodeCoord('{"type":"stage.fwd","sessionId":"s","seq":-1,"shape":[1,8],"dtype":"f16","payload":"AA=="}'), null);
    assert.equal(decodeCoord('{"type":"stage.fwd","sessionId":"s","seq":0,"shape":[0,8],"dtype":"f16","payload":"AA=="}'), null);
  });

  it("B2: stage.replay (heal por stage-cache) roundtrip + validación", () => {
    const rp = {
      type: "stage.replay" as const, sessionId: "j1:s0", uptoSeq: 7,
      target: { endpoint: "5.6.7.8:9001", sessionId: "j1:s1r3", token: "ef".repeat(32), coordPubkey: "GC" },
    };
    assert.deepEqual(decodeCoord(encode(rp)), rp);
    assert.equal(decodeCoord('{"type":"stage.replay","sessionId":"s","uptoSeq":-1,"target":{"endpoint":"e:1","sessionId":"x"}}'), null);
    assert.equal(decodeCoord('{"type":"stage.replay","sessionId":"s","target":{"endpoint":"e:1","sessionId":"x"}}')?.type, "stage.replay");
    assert.equal(decodeCoord('{"type":"stage.replay","sessionId":"s","target":{"endpoint":"","sessionId":"x"}}'), null);
  });
});

describe("B1 capability token (stageToken/stageTokenOk)", () => {
  const SECRET = "s3cr3t-stage";
  const JOB = "job-9";
  const COORD = "GCOORDPUBKEY";

  it("token válido verifica — determinístico y distinto por jobId/coord", () => {
    const t = stageToken(SECRET, JOB, COORD);
    assert.equal(t.length, 64);
    assert.ok(stageTokenOk(SECRET, JOB, COORD, t));
    assert.equal(stageToken(SECRET, JOB, COORD), t); // determinístico
  });

  it("rechaza: otro jobId, otro coordPubkey, otro secret, token tampered, vacío", () => {
    const t = stageToken(SECRET, JOB, COORD);
    assert.ok(!stageTokenOk(SECRET, "otro-job", COORD, t));
    assert.ok(!stageTokenOk(SECRET, JOB, "GOTROPUB", t));
    assert.ok(!stageTokenOk("otro-secret", JOB, COORD, t));
    assert.ok(!stageTokenOk(SECRET, JOB, COORD, `${t.slice(0, -2)}ff`));
    assert.ok(!stageTokenOk(SECRET, JOB, COORD, ""));
    assert.ok(!stageTokenOk(SECRET, JOB, COORD, t.toUpperCase()));
    // length desigual no rompe timingSafeEqual (guard explícito)
    assert.ok(!stageTokenOk(SECRET, JOB, COORD, "ab"));
  });
});

describe("S47 stageproto stage→coord", () => {
  it("stage.ack / out / fail roundtrip", () => {
    const ack = { type: "stage.ack" as const, sessionId: "s1" };
    assert.deepEqual(decodeStage(encode(ack)), ack);
    // A4: close-ack con sig — la firma del tramo viaja en el ack.
    const ackSig = { type: "stage.ack" as const, sessionId: "s1", sig: "ab".repeat(64) };
    assert.deepEqual(decodeStage(encode(ackSig)), ackSig);
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
    assert.equal(decodeStage(`{"type":"stage.ack","sessionId":"s","sig":"${"x".repeat(301)}"}`), null);
    assert.equal(decodeStage('{"type":"stage.fail","sessionId":"s"}'), null);
  });

  it("B2: stage.report (blame ligero) + ack con inChain/outChain", () => {
    const rep = { type: "stage.report" as const, sessionId: "j1:s1", seq: 12 };
    assert.deepEqual(decodeStage(encode(rep)), rep);
    assert.equal(decodeStage('{"type":"stage.report","sessionId":"s","seq":-1}'), null);
    assert.equal(decodeStage('{"type":"stage.report","sessionId":"s"}'), null);
    // close-ack v2: firma ata inChain+outChain (frontera verificable)
    const ack = {
      type: "stage.ack" as const, sessionId: "s", sig: "ab".repeat(64),
      inChain: "aa".repeat(32), outChain: "bb".repeat(32),
    };
    assert.deepEqual(decodeStage(encode(ack)), ack);
    // inChain sin outChain (o viceversa) → inválido: la frontera se firma en par
    assert.equal(decodeStage(`{"type":"stage.ack","sessionId":"s","sig":"x","inChain":"${"aa".repeat(32)}"}`), null);
    assert.equal(decodeStage(`{"type":"stage.ack","sessionId":"s","sig":"x","inChain":"xx","outChain":"${"bb".repeat(32)}"}`), null);
  });
});

describe("S47 chain de activaciones (A4)", () => {
  it("fórmula canónica — stage y coordinator computan el mismo chain", () => {
    // El vector lo fija el spec: init = sha256hex(sid:k-n); step encadena
    // (seq,in,out). Ambas partes DEBEN producir bytes idénticos o el sig
    // no ata la misma historia.
    const c0 = stageChainInit("j1:s0", [0, 16]);
    assert.equal(c0, createHash("sha256").update("j1:s0:0-16", "utf8").digest("hex"));
    const c1 = stageChainStep(c0, 0, "aW5wdXQ=", "b3V0cHV0");
    assert.equal(c1, createHash("sha256").update(`${c0}:0:aW5wdXQ=:b3V0cHV0`, "utf8").digest("hex"));
    const c2 = stageChainStep(c1, 1, "eA==", "eQ==");
    assert.notEqual(c2, c1);
    // Determinístico: mismos pasos → mismo chain.
    const again = stageChainStep(stageChainStep(stageChainInit("j1:s0", [0, 16]), 0, "aW5wdXQ=", "b3V0cHV0"), 1, "eA==", "eQ==");
    assert.equal(again, c2);
    // Preimage firmable: sha256(jobId:sessionId:chain) en bytes.
    const pre = stageSigPreimage("j1", "j1:s0", c2);
    assert.equal(pre.toString("hex"), createHash("sha256").update(`j1:j1:s0:${c2}`, "utf8").digest("hex"));
    assert.equal(pre.length, 32);
  });
});

describe("B2 boundary chains (in/out por separado)", () => {
  it("inChain de K+1 == outChain de K cuando la frontera viajó intacta", () => {
    // Los half-chains se siembran SOLO con jobId — compartido por toda la
    // cadena, porque la entrada de s1 en seq n ES la salida de s0 en seq n.
    // El session-binding vive en el preimage firmado, no en el seed.
    const seed = stageHalfInit("j1");
    const outA = stageHalfStep(stageHalfStep(seed, 0, "aW5wdXQ="), 1, "eA==");
    const inB = stageHalfStep(stageHalfStep(seed, 0, "aW5wdXQ="), 1, "eA==");
    assert.equal(inB, outA); // frontera intacta → convergen byte a byte
    // un payload tampered rompe la convergencia
    const inB2 = stageHalfStep(stageHalfStep(seed, 0, "aW5wdXQ="), 1, "eQ==");
    assert.notEqual(inB2, outA);
    // formula fija: seed = sha256hex(jobId); step = sha256hex(prev:seq:payload)
    const expectSeed = createHash("sha256").update("j1", "utf8").digest("hex");
    const expect = createHash("sha256").update(
      `${createHash("sha256").update(`${expectSeed}:0:aW5wdXQ=`, "utf8").digest("hex")}:1:eA==`, "utf8",
    ).digest("hex");
    assert.equal(inB, expect);
  });

  it("preimage v2 ata inChain+outChain juntos", () => {
    const pre = stageSigPreimageV2("j1", "j1:s0", "aa".repeat(32), "bb".repeat(32));
    assert.equal(pre.toString("hex"), createHash("sha256").update(`j1:j1:s0:${"aa".repeat(32)}:${"bb".repeat(32)}`, "utf8").digest("hex"));
    assert.equal(pre.length, 32);
    // distinto del v1: no collide con sha256(jobId:sid:chain)
    const preV1 = stageSigPreimage("j1", "j1:s0", "aa".repeat(32));
    assert.notEqual(pre.toString("hex"), preV1.toString("hex"));
  });
});
