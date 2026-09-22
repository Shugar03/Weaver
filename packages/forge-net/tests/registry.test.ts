// S30 — ForgeRegistry: identidad por pubkey, capacidad por heartbeat, TTL.
// Reglas puras: clock inyectado, sin sockets ni Stellar.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ForgeRegistry, HEARTBEAT_TTL_MS } from "../src/registry.ts";
import { InMemoryForgeStore } from "../src/store.ts";
import type { InstanceReport } from "../src/protocol.ts";

const inst = (over: Partial<InstanceReport> = {}): InstanceReport => ({
  instanceId: "gpu0-qwen",
  model: "qwen3:4b",
  capability: "text",
  hot: true,
  inFlight: 0,
  saturated: false,
  loadTimeMs: 3000,
  ...over,
});

describe("S30 ForgeRegistry", () => {
  it("register + heartbeat → views con instance como forgeId y pubkey como owner", async () => {
    const r = new ForgeRegistry(new InMemoryForgeStore());
    await r.register("GPUB1");
    assert.equal(r.heartbeat("GPUB1", [inst()]), true);
    const v = r.views();
    assert.equal(v.length, 1);
    assert.equal(v[0].forgeId, "gpu0-qwen");
    assert.equal(v[0].forgePubkey, "GPUB1");
    assert.equal(v[0].remote, true);
    assert.equal(v[0].capability, "text");
    assert.equal(v[0].attested, false); // recién registrado: no verificado
  });

  it("heartbeat sin registro → false (el ws-server cierra/re-autentica)", async () => {
    const r = new ForgeRegistry();
    assert.equal(r.heartbeat("GNUNCA", [inst()]), false);
    assert.equal(r.views().length, 0);
  });

  it("expira sin heartbeat: TTL → la session muere y sale de views", async () => {
    let now = 1_000_000;
    const r = new ForgeRegistry(undefined, () => now);
    await r.register("GPUB1");
    r.heartbeat("GPUB1", [inst()]);
    assert.equal(r.views().length, 1);
    now += HEARTBEAT_TTL_MS + 1;
    assert.deepEqual(r.expire(), ["GPUB1"]);
    assert.equal(r.views().length, 0);
    // heartbeat posterior → rechazado (debe re-registrarse)
    assert.equal(r.heartbeat("GPUB1", [inst()]), false);
  });

  it("heartbeat refresca lastSeen: la session no expira mientras reporte", async () => {
    let now = 1_000_000;
    const r = new ForgeRegistry(undefined, () => now);
    await r.register("GPUB1");
    for (let i = 0; i < 5; i++) {
      r.heartbeat("GPUB1", [inst()]);
      now += 5_000;
    }
    assert.equal(r.expire().length, 0);
    assert.equal(r.views().length, 1);
  });

  it("rig: N instances de un pubkey → N views, mismo forgePubkey", async () => {
    const r = new ForgeRegistry();
    await r.register("GRIG1");
    r.heartbeat("GRIG1", [inst(), inst({ instanceId: "gpu1-gemma", model: "gemma4:e2b", saturated: true })]);
    const v = r.views();
    assert.equal(v.length, 2);
    assert.ok(v.every((f) => f.forgePubkey === "GRIG1"));
    assert.equal(v.find((f) => f.forgeId === "gpu1-gemma")?.saturated, true);
    assert.equal(v.find((f) => f.forgeId === "gpu0-qwen")?.saturated, false);
  });

  it("instanceId duplicado dentro del mismo heartbeat → dedup (último gana)", async () => {
    const r = new ForgeRegistry();
    await r.register("GPUB1");
    r.heartbeat("GPUB1", [inst({ model: "viejo" }), inst({ model: "nuevo" })]);
    const v = r.views();
    assert.equal(v.length, 1);
    assert.equal(v[0].model, "nuevo");
  });

  it("attest() marca la instance; pubkeyOf resuelve el payout", async () => {
    const r = new ForgeRegistry(new InMemoryForgeStore());
    await r.register("GPUB1");
    r.heartbeat("GPUB1", [inst()]);
    assert.equal(r.views()[0].attested, false);
    r.attest("GPUB1", "gpu0-qwen");
    assert.equal(r.views()[0].attested, true);
    assert.equal(r.pubkeyOf("gpu0-qwen"), "GPUB1");
    assert.equal(r.pubkeyOf("nope"), undefined);
  });

  it("instanceId ya reclamado por otro forge → no entra al view del segundo", async () => {
    const r = new ForgeRegistry();
    await r.register("GUNO");
    await r.register("GDOS");
    r.heartbeat("GUNO", [inst()]);
    r.heartbeat("GDOS", [inst(), inst({ instanceId: "propio" })]);
    const v = r.views();
    assert.equal(v.length, 2); // gpu0-qwen solo de GUNO + propio de GDOS
    assert.equal(v.find((f) => f.forgeId === "gpu0-qwen")?.forgePubkey, "GUNO");
    assert.equal(v.find((f) => f.forgeId === "propio")?.forgePubkey, "GDOS");
  });

  it("rtt medido por ping/pong entra al view (reemplaza el default)", async () => {
    const r = new ForgeRegistry();
    await r.register("GPUB1");
    r.heartbeat("GPUB1", [inst()]);
    assert.equal(r.views()[0].rttMs, 50); // default declarado
    r.setRtt("GPUB1", 12);
    assert.equal(r.views()[0].rttMs, 12); // medido
  });
});
