// S47 — transport TCP real: tcpStageDial ↔ startStageServer(simStageCompute).
// Los bytes viajan por loopback — no hay fake de socket.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tcpStageDial } from "../src/stagetransport.ts";
import { startStageServer } from "../src/stageserver.ts";
import { simStageCompute } from "../src/pipeline.ts";

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
      /sin sesión/,
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
});
