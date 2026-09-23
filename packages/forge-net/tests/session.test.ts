// S32 — ForgeSession: auth firmada + nonce single-use + heartbeat → registry.
// Fake verify inyectado; sin sockets (la sesión recibe/emite strings).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ForgeSession } from "../src/session.ts";
import { ForgeRegistry } from "../src/registry.ts";
import { NonceStore } from "../src/nonce.ts";
import { encode } from "../src/protocol.ts";

const inst = {
  instanceId: "gpu0",
  model: "qwen3:4b",
  capability: "text" as const,
  hot: true,
  inFlight: 0,
  saturated: false,
  loadTimeMs: 3000,
};

function rig(over: { verifyOk?: boolean } = {}) {
  const registry = new ForgeRegistry();
  const nonces = new NonceStore();
  const sent: string[] = [];
  let closed = false;
  const verify = (pk: string, _msg: Buffer, sig: Buffer) => (over.verifyOk === false ? false : sig.toString("hex") === "cafe");
  const session = new ForgeSession({
    send: (raw) => sent.push(raw),
    requestClose: () => (closed = true),
    registry,
    verify,
    consumeNonce: (n) => nonces.consume(n),
    authTimeoutMs: 60_000, // no interfiere en el test
  });
  return { registry, nonces, sent, session, isClosed: () => closed };
}

const auth = (nonce: string, pubkey = "GABC", signature = "cafe") =>
  encode({ type: "auth", pubkey, nonce, signature });

describe("S32 ForgeSession auth", () => {
  it("nonce válido + firma válida → auth.ok + registrado en registry", async () => {
    const r = rig();
    const { nonce } = r.nonces.issue();
    await r.session.onRaw(auth(nonce));
    assert.equal(r.sent.at(-1), encode({ type: "auth.ok", pubkey: "GABC" }));
    assert.deepEqual(r.registry.sessionsAlive(), ["GABC"]);
  });

  it("firma inválida → auth.fail + close (el nonce se consume igual)", async () => {
    const r = rig({ verifyOk: false });
    const { nonce } = r.nonces.issue();
    await r.session.onRaw(auth(nonce));
    assert.match(r.sent.at(-1)!, /auth\.fail/);
    assert.ok(r.isClosed());
    assert.deepEqual(r.registry.sessionsAlive(), []);
    assert.equal(r.nonces.consume(nonce), false); // consumido: no reuso
  });

  it("nonce inventado o reusado → rechazado", async () => {
    const r = rig();
    await r.session.onRaw(auth("nonce-que-no-existe"));
    assert.ok(r.isClosed());
    const r2 = rig();
    const { nonce } = r2.nonces.issue();
    r2.nonces.consume(nonce); // consumido por otro intento
    await r2.session.onRaw(auth(nonce));
    assert.ok(r2.isClosed());
  });

  it("mensaje no-auth antes de autenticar → close", async () => {
    const r = rig();
    await r.session.onRaw(encode({ type: "heartbeat", instances: [inst] }));
    assert.ok(r.isClosed());
    assert.equal(r.registry.views().length, 0);
  });
});

describe("S32 ForgeSession post-auth", () => {
  it("heartbeat → instance visible en views; close → unregister", async () => {
    const r = rig();
    const { nonce } = r.nonces.issue();
    await r.session.onRaw(auth(nonce));
    await r.session.onRaw(encode({ type: "heartbeat", instances: [inst] }));
    assert.equal(r.registry.views().length, 1);
    assert.equal(r.registry.views()[0].forgeId, "gpu0");
    r.session.closed();
    assert.deepEqual(r.registry.sessionsAlive(), []);
  });

  it("pong → RTT medido entra al registry", async () => {
    const r = rig();
    const { nonce } = r.nonces.issue();
    await r.session.onRaw(auth(nonce));
    await r.session.onRaw(encode({ type: "heartbeat", instances: [inst] }));
    await r.session.onRaw(encode({ type: "pong", t: Date.now() - 7 }));
    const rtt = r.registry.views()[0].rttMs;
    assert.ok(rtt >= 7 && rtt < 50_000);
  });

  it("frames job.* llegan a los listeners (remote execs)", async () => {
    const r = rig();
    const { nonce } = r.nonces.issue();
    await r.session.onRaw(auth(nonce));
    const got: string[] = [];
    r.session.onMessage((m) => got.push(m.type));
    await r.session.onRaw(encode({ type: "job.chunk", jobId: "j", token: "x" }));
    await r.session.onRaw(encode({ type: "job.done", jobId: "j", resultHash: "aa", signature: "bb" }));
    assert.deepEqual(got, ["job.chunk", "job.done"]);
  });

  it("heartbeat flood: <500ms entre heartbeats se dropea; 5 seguidos → kill", async () => {
    const r = rig();
    const { nonce } = r.nonces.issue();
    await r.session.onRaw(auth(nonce));
    const hb = () => r.session.onRaw(encode({ type: "heartbeat", instances: [inst] }));
    await hb();
    assert.equal(r.registry.views().length, 1);

    // 4 floods seguidos: dropeados pero la sesión sobrevive (tolerante).
    for (let i = 0; i < 4; i++) await hb();
    assert.equal(r.isClosed(), false);
    // el registry sigue sano — el flood no tocó nada
    assert.equal(r.registry.views().length, 1);

    // la 5ta violación mata la sesión (abuso de protocolo, no latencia)
    await hb();
    assert.equal(r.isClosed(), true);
  });

  it("heartbeat espaciado no cuenta como flood", async () => {
    const r = rig();
    const { nonce } = r.nonces.issue();
    await r.session.onRaw(auth(nonce));
    const session = r.session as unknown as { lastHbAt: number };
    const hb = async () => {
      await r.session.onRaw(encode({ type: "heartbeat", instances: [inst] }));
      // simular el paso del tiempo — el timer real no corre en el test
      session.lastHbAt -= 1000;
    };
    await hb();
    for (let i = 0; i < 6; i++) await hb();
    assert.equal(r.isClosed(), false);
    assert.equal(r.registry.views().length, 1);
  });

  it("ping() sale por el socket con timestamp", async () => {
    const r = rig();
    const { nonce } = r.nonces.issue();
    await r.session.onRaw(auth(nonce));
    r.session.ping();
    const p = JSON.parse(r.sent.at(-1)!);
    assert.equal(p.type, "ping");
    assert.equal(typeof p.t, "number");
  });
});
