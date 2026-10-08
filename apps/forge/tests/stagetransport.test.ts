// S47 — transport TCP real: tcpStageDial ↔ startStageServer(simStageCompute).
// Los bytes viajan por loopback — no hay fake de socket.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tcpStageDial } from "../src/stagetransport.ts";
import { startStageServer } from "../src/stageserver.ts";
import { simStageCompute } from "../src/pipeline.ts";
import { stageChainInit, stageChainStep, stageHalfInit, stageHalfStep, stageSigPreimageV2, stageToken } from "@weaver/forge-net";
import { stellarKeypair, stellarVerify } from "@weaver/settlement";

const bind = async (compute: ReturnType<typeof simStageCompute>) => {
  const srv = startStageServer({ host: "127.0.0.1", port: 0, compute });
  await srv.ready;
  return { srv, endpoint: `127.0.0.1:${srv.port}` };
};

describe("S47 stage transport TCP", () => {
  it("open → step → close por socket real", async () => {
    const compute = simStageCompute([0, 16], "s0");
    const { srv, endpoint } = await bind(compute);
    const t = tcpStageDial(endpoint);
    await t.open({ jobId: "j1", sessionId: "s1", model: "m", blocks: [0, 16] });
    const r = await t.step({
      sessionId: "s1",
      seq: 0,
      shape: [1, 4],
      dtype: "f16",
      payload: Buffer.from("hola").toString("base64"),
    });
    // El stage marcó la activación — bytes que realmente cruzaron el socket.
    assert.equal(Buffer.from(r.payload, "base64").toString("utf8"), "hola:s0");
    t.close("s1");
    await new Promise((r2) => setTimeout(r2, 20));
    assert.equal(compute.sessions(), 0);
    t.dispose();
    srv.close();
  });

  it("blocks fuera del rango del stage → stage.fail con error honesto", async () => {
    const { srv, endpoint } = await bind(simStageCompute([0, 16], "s0"));
    const t = tcpStageDial(endpoint);
    await assert.rejects(
      t.open({ jobId: "j1", sessionId: "s1", model: "m", blocks: [0, 40] }),
      /fuera de mi rango/,
    );
    t.dispose();
    srv.close();
  });

  it("stage sin sesión → step rechazado con stage.fail", async () => {
    const { srv, endpoint } = await bind(simStageCompute([0, 16], "s0"));
    const t = tcpStageDial(endpoint);
    await assert.rejects(
      t.step({ sessionId: "nunca-abierta", seq: 0, shape: [1, 4], dtype: "f16", payload: "eA==" }),
      /sesión ajena o inexistente/,
    );
    t.dispose();
    srv.close();
  });

  it("socket muerto → sesiones liberadas (no quedan zombie)", async () => {
    const compute = simStageCompute([0, 16], "s0");
    const { srv, endpoint } = await bind(compute);
    const t = tcpStageDial(endpoint);
    await t.open({ jobId: "j1", sessionId: "s1", model: "m", blocks: [0, 16] });
    assert.equal(compute.sessions(), 1);
    t.dispose(); // mata el socket SIN stage.close — el server libera igual
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(compute.sessions(), 0);
    srv.close();
  });

  it("endpoint muerto → open rechaza (connect timeout/ECONNREFUSED)", async () => {
    const t = tcpStageDial("127.0.0.1:1", 500);
    await assert.rejects(t.open({ jobId: "j", sessionId: "s", model: "m", blocks: [0, 8] }));
    t.dispose();
  });

  it("A4+B2: close-ack lleva sig ed25519 real + half-chains de frontera", async () => {
    const kp = stellarKeypair();
    const compute = simStageCompute([0, 16], "s0", async (h) => kp.sign(h).toString("hex"));
    const { srv, endpoint } = await bind(compute);
    const t = tcpStageDial(endpoint);
    await t.open({ jobId: "j1", sessionId: "j1:s0", model: "m", blocks: [0, 16] });
    const r = await t.step({ sessionId: "j1:s0", seq: 0, shape: [1, 4], dtype: "f16", payload: Buffer.from("hola").toString("base64") });
    const { sig, inChain, outChain } = await t.close("j1:s0");
    assert.ok(sig, "el close-ack debía traer la firma del tramo");
    assert.ok(inChain && outChain, "el ack debía traer los half-chains");
    // v2: la firma ata (jobId, sessionId, inChain, outChain) — verifico con
    // el mismo preimage que firmó el stage.
    assert.equal(stellarVerify(kp.pubkey, stageSigPreimageV2("j1", "j1:s0", inChain!, outChain!), Buffer.from(sig!, "hex")), true);
    // El outChain que reportó es el que el coordinator recomputa sobre el
    // tráfico observado — coinciden ⇒ el tramo viajó intacto.
    const expectOut = stageHalfStep(stageHalfInit("j1"), 0, r.payload);
    assert.equal(outChain, expectOut);
    // Una frontera distinta NO verifica — la firma ata la historia real.
    assert.equal(stellarVerify(kp.pubkey, stageSigPreimageV2("j1", "j1:s0", inChain!, "00".repeat(32)), Buffer.from(sig!, "hex")), false);
    t.dispose();
    srv.close();
  });

  it("B1: open sin capability → stage.fail, cero sesión alocada (TCP real)", async () => {
    const SECRET = "w4n-s3cr3t";
    const compute = simStageCompute([0, 16], "s0", undefined, SECRET);
    const { srv, endpoint } = await bind(compute);
    // Un cliente de Internet sin token → rechazado ANTES de reservar KV.
    const t = tcpStageDial(endpoint);
    await assert.rejects(
      t.open({ jobId: "j1", sessionId: "s1", model: "m", blocks: [0, 16] }),
      /capability/,
    );
    assert.equal(compute.sessions(), 0); // nada alocado
    t.dispose();
    // Token minteado por otro secret → también rechazado.
    const t2 = tcpStageDial(endpoint);
    await assert.rejects(
      t2.open({ jobId: "j1", sessionId: "s1", model: "m", blocks: [0, 16], token: stageToken("otro-secret", "j1", "GCOORD"), coordPubkey: "GCOORD" }),
      /capability/,
    );
    // Token del jobId equivocado → rechazado (ata (jobId, coordPubkey)).
    const t3 = tcpStageDial(endpoint);
    await assert.rejects(
      t3.open({ jobId: "j1", sessionId: "s1", model: "m", blocks: [0, 16], token: stageToken(SECRET, "jOTRO", "GCOORD"), coordPubkey: "GCOORD" }),
      /capability/,
    );
    assert.equal(compute.sessions(), 0);
    t2.dispose();
    t3.dispose();
    // Capability válida → sesión normal.
    const t4 = tcpStageDial(endpoint);
    await t4.open({ jobId: "j1", sessionId: "s1", model: "m", blocks: [0, 16], token: stageToken(SECRET, "j1", "GCOORD"), coordPubkey: "GCOORD" });
    assert.equal(compute.sessions(), 1);
    t4.dispose();
    srv.close();
  });
});

// B2 — data plane directo stage→stage por sockets REALES: el coordinator
// inyecta en s1; s1 forwardea a s2 (credenciales courier); s2 devuelve
// stage.out por el socket dueño. Relay = sin next (cubierto arriba).
describe("B2 direct stage→stage (TCP real)", () => {
  const SECRET = "w4n-s3cr3t";
  const COORD = "GCOORD";

  it("open con next → inject en s1 → fwd → out de s2 por socket dueño", async () => {
    const c1 = simStageCompute([0, 8], "s0", undefined, SECRET);
    const c2 = simStageCompute([8, 16], "s1", undefined, SECRET);
    const a = await bind(c1);
    const b = await bind(c2);
    const t1 = tcpStageDial(a.endpoint);
    const t2 = tcpStageDial(b.endpoint);
    // El coordinator abre AMBAS sesiones (control plane + B1 auth) y le dice
    // a s1 a dónde forwardear + las credenciales de la sesión destino.
    const tok2 = stageToken(SECRET, "j1", COORD);
    await t1.open({ jobId: "j1", sessionId: "j1:s0", model: "m", blocks: [0, 8], token: stageToken(SECRET, "j1", COORD), coordPubkey: COORD, next: { endpoint: b.endpoint, sessionId: "j1:s1", token: tok2, coordPubkey: COORD } });
    await t2.open({ jobId: "j1", sessionId: "j1:s1", model: "m", blocks: [8, 16], token: tok2, coordPubkey: COORD });
    const reports: number[] = [];
    t1.onEvent?.((m) => {
      if (m.type === "stage.report") reports.push(m.seq);
    });
    // Inyecta el prompt-embed en s1 — s2 jamás ve un stage.step directo.
    t1.inject({ sessionId: "j1:s0", seq: 0, shape: [1, 4], dtype: "f16", payload: Buffer.from("hola").toString("base64") });
    const r = await t2.expectOut("j1:s1", 0);
    assert.equal(Buffer.from(r.payload, "base64").toString("utf8"), "hola:s0:s1"); // pasó por AMBOS
    assert.deepEqual(reports, [0]); // s1 reportó al coordinator
    // El out de s2 fue al socket DUEÑO (este t2) — no al socket del fwd.
    const r2p = t2.expectOut("j1:s1", 1);
    t1.inject({ sessionId: "j1:s0", seq: 1, shape: [1, 4], dtype: "f16", payload: Buffer.from("hola:s0:s1").toString("base64") });
    assert.equal(Buffer.from((await r2p).payload, "base64").toString("utf8"), "hola:s0:s1:s0:s1");
    t1.dispose();
    t2.dispose();
    a.srv.close();
    b.srv.close();
  });

  it("fwd con credenciales ajenas → stage.fail, cero cómputo (rogue WAN)", async () => {
    const c2 = simStageCompute([8, 16], "s1", undefined, SECRET);
    const b = await bind(c2);
    const t2 = tcpStageDial(b.endpoint);
    await t2.open({ jobId: "j1", sessionId: "j1:s1", model: "m", blocks: [8, 16], token: stageToken(SECRET, "j1", COORD), coordPubkey: COORD });
    // Un tercero inyecta un fwd con token robado/inválido → rechazado.
    // El stage.fail va al OWNER de la sesión (t2, el coordinator) — es quien
    // decide blame/heal; al rogue no se le devuelve nada.
    const rogue = tcpStageDial(b.endpoint);
    const fails: string[] = [];
    t2.onEvent?.((m) => {
      if (m.type === "stage.fail") fails.push(m.error);
    });
    rogue.injectFwd({ sessionId: "j1:s1", seq: 0, shape: [1, 4], dtype: "f16", payload: "eA==", token: "0".repeat(64), coordPubkey: "GMAL" });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(fails.length, 1);
    assert.match(fails[0], /credenciales/);
    assert.equal(c2.sessions(), 1); // la sesión existe pero NO recibió nada
    assert.deepEqual(c2.seqsOf("j1:s1"), []);
    // fwd sin credenciales cuando la sesión SÍ las tiene → igual rechazo.
    rogue.injectFwd({ sessionId: "j1:s1", seq: 0, shape: [1, 4], dtype: "f16", payload: "eA==" });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(fails.length, 2);
    t2.dispose();
    rogue.dispose();
    b.srv.close();
  });

  it("dup seq → redeliver del cache (no recompute), absorb → KV sin propagar", async () => {
    const c1 = simStageCompute([0, 8], "s0", undefined, SECRET);
    const c2 = simStageCompute([8, 16], "s1", undefined, SECRET);
    const a = await bind(c1);
    const b = await bind(c2);
    const t1 = tcpStageDial(a.endpoint);
    const t2 = tcpStageDial(b.endpoint);
    const tok = stageToken(SECRET, "j1", COORD);
    await t1.open({ jobId: "j1", sessionId: "j1:s0", model: "m", blocks: [0, 8], token: tok, coordPubkey: COORD, next: { endpoint: b.endpoint, sessionId: "j1:s1", token: tok, coordPubkey: COORD } });
    await t2.open({ jobId: "j1", sessionId: "j1:s1", model: "m", blocks: [8, 16], token: tok, coordPubkey: COORD });
    t1.inject({ sessionId: "j1:s0", seq: 0, shape: [1, 4], dtype: "f16", payload: Buffer.from("x").toString("base64") });
    await t2.expectOut("j1:s1", 0);
    // Re-inyectar seq 0 en s1 (heal wave): s1 dedup → reenvía CACHED out;
    // s2 dedup → reenvía CACHED out al dueño — ningún stage recomputa.
    const dup = t2.expectOut("j1:s1", 0);
    t1.inject({ sessionId: "j1:s0", seq: 0, shape: [1, 4], dtype: "f16", payload: Buffer.from("x").toString("base64") });
    assert.equal(Buffer.from((await dup).payload, "base64").toString("utf8"), "x:s0:s1");
    assert.equal(c1.seqsOf("j1:s0").length, 1); // una sola computación real
    assert.equal(c2.seqsOf("j1:s1").length, 1);
    t1.dispose();
    t2.dispose();
    a.srv.close();
    b.srv.close();
  });

  it("replay: s1 reenvía sus outs cacheados a un reemplazo (absorb → KV, sin propagar)", async () => {
    const c1 = simStageCompute([0, 8], "s0", undefined, SECRET);
    const c2 = simStageCompute([8, 16], "s1", undefined, SECRET);
    const c2r = simStageCompute([8, 16], "s1", undefined, SECRET); // reemplazo
    const a = await bind(c1);
    const b = await bind(c2);
    const br = await bind(c2r);
    const t1 = tcpStageDial(a.endpoint);
    const t2 = tcpStageDial(b.endpoint);
    const tr = tcpStageDial(br.endpoint);
    const tok = stageToken(SECRET, "j1", COORD);
    await t1.open({ jobId: "j1", sessionId: "j1:s0", model: "m", blocks: [0, 8], token: tok, coordPubkey: COORD, next: { endpoint: b.endpoint, sessionId: "j1:s1", token: tok, coordPubkey: COORD } });
    await t2.open({ jobId: "j1", sessionId: "j1:s1", model: "m", blocks: [8, 16], token: tok, coordPubkey: COORD });
    await tr.open({ jobId: "j1", sessionId: "j1:s1r", model: "m", blocks: [8, 16], token: tok, coordPubkey: COORD });
    // Dos tokens fluyen por la cadena — s1 cachea sus outs.
    for (const [n, p] of [[0, "p0"], [1, "p1"]] as const) {
      t1.inject({ sessionId: "j1:s0", seq: n, shape: [1, 4], dtype: "f16", payload: Buffer.from(p).toString("base64") });
      await t2.expectOut("j1:s1", n);
    }
    // s2 "murió" → el coordinator pide a s1 que replay su cache al reemplazo.
    await t1.replay("j1:s0", 1, { endpoint: br.endpoint, sessionId: "j1:s1r", token: tok, coordPubkey: COORD });
    await new Promise((r) => setTimeout(r, 80));
    // El reemplazo absorbió la historia completa (computó para reconstruir KV).
    assert.deepEqual(c2r.seqsOf("j1:s1r"), [0, 1]);
    // ...y NO propagó nada (los absorbs no llegan a ningún lado — no hay next).
    assert.equal(c2r.seqsOf("j1:s1r").length, 2);
    t1.dispose();
    t2.dispose();
    tr.dispose();
    a.srv.close();
    b.srv.close();
    br.srv.close();
  });

  it("PipelineExec direct: tokens por cadena real + heal mid-job (K-1 replaya su cache)", async () => {
    const { PipelineExec, simFront } = await import("../src/pipeline.ts");
    const SECRET2 = "w4n-p1pe";
    const COORD2 = "GPIPE";
    const tok = stageToken(SECRET2, "j1", COORD2);
    const kpDead = stellarKeypair();
    const kpRepl = stellarKeypair();
    // s2 LENTO (25ms/step): en loopback la cadena completa 4 tokens en ~2ms —
    // sin delay el job termina antes de que el kill llegue y el heal jamás
    // se ejercita (falso verde). El delay abre una ventana mid-job real.
    const slow = <T extends { step: (m: never) => unknown }>(c: T, ms: number): T => {
      const s0 = c.step.bind(c);
      (c as { step: unknown }).step = async (m: never) => {
        await new Promise((r) => setTimeout(r, ms));
        return s0(m);
      };
      return c;
    };
    const c1 = simStageCompute([0, 8], "s0", async (h) => kp0.sign(h).toString("hex"), SECRET2);
    const c2 = slow(simStageCompute([8, 16], "s1", async (h) => kpDead.sign(h).toString("hex"), SECRET2), 25);
    const c2r = slow(simStageCompute([8, 16], "s9", async (h) => kpRepl.sign(h).toString("hex"), SECRET2), 25); // spare
    const a = await bind(c1);
    const b = await bind(c2);
    const br = await bind(c2r);
    let requested = 0;
    const exec = new PipelineExec({
      forgeId: "f1",
      model: "m",
      stages: [
        { endpoint: a.endpoint, blocks: [0, 8], token: tok },
        { endpoint: b.endpoint, blocks: [8, 16], token: tok },
      ],
      dial: (e) => tcpStageDial(e),
      front: simFront(),
      coordPubkey: COORD2,
      mode: "direct",
      stepTimeoutMs: 4_000,
      // El gateway reemplaza el tramo muerto con el spare (capability fresca).
      requestStage: async () => {
        requested++;
        return { endpoint: br.endpoint, blocks: [8, 16], token: stageToken(SECRET2, "j1", COORD2) };
      },
    });
    const tokens: string[] = [];
    let done: { stats?: { genTokens?: number }; stageSigs?: { endpoint: string; sig: string }[] } = {};
    const run = (async () => {
      for await (const c of exec.execute({ jobId: "j1", model: "m", prompt: "a b c d", options: { maxTokens: 4 } } as never)) {
        if (c.done) done = c as typeof done;
        else tokens.push(c.token);
      }
    })();
    // Kill determinístico: s2 cae tras procesar 2 seqs reales — el seq
    // siguiente queda en vuelo (o por inyectar) y dispara el heal.
    while (c2.seenSeqs().length < 2) await new Promise((r) => setTimeout(r, 3));
    b.srv.close();
    await run;
    assert.deepEqual(tokens, ["a ", "b ", "c ", "d "], "los 4 tokens llegaron pese al stage muerto");
    assert.equal(done.stats?.genTokens, 4);
    assert.equal(requested, 1, "el coordinator pidió exactamente un reemplazo");
    // s1 replayó su cache al reemplazo (absorb: seqs ≤ el del kill) y el
    // reemplazo computó el resto — historia completa reconstruida.
    const replSeqs = c2r.seenSeqs().filter((s) => s.sessionId.startsWith("j1:s1r")).map((s) => s.seq);
    assert.ok(replSeqs.length > 0, "el reemplazo absorbió historia del cache de s1");
    // stageSigs: el vivo (s1) y el REEMPLAZO firman — el muerto no (su ack
    // nunca llegó). La frontera s1→s2' verifica: out_s1 == in_s2'.
    const sigs = done.stageSigs ?? [];
    assert.equal(sigs.length, 2);
    assert.equal(sigs[0].endpoint, a.endpoint);
    assert.equal(sigs[1].endpoint, br.endpoint); // jamás el endpoint muerto
    a.srv.close();
    br.srv.close();
  });
});

const kp0 = stellarKeypair();
