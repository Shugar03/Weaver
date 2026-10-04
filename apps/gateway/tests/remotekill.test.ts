// spec 011 — chaos kill sobre forges remotos.
// makeKillSwitch es puro (resuelve instanceId→pubkey, set de matados,
// closeSession por callback) — la semántica completa se testea sin sockets.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeKillSwitch } from "../src/forgews.ts";

const rig = (instances: Record<string, string>) => {
  // instanceId → pubkey — lo que el registry sabe post-heartbeat.
  const owners = new Map(Object.entries(instances));
  const closed: string[] = [];
  const kill = makeKillSwitch({
    pubkeyOf: (id) => owners.get(id),
    closeSession: (pk) => closed.push(pk),
  });
  return { kill, closed };
};

describe("spec 011 — remote chaos kill switch", () => {
  it("kill de instance conocida → pubkey matada + sesión cerrada", () => {
    const { kill, closed } = rig({ live1: "0xAAA", live2: "0xBBB" });
    assert.equal(kill.setDead("live1", true), true);
    assert.deepEqual(closed, ["0xAAA"]);
    assert.equal(kill.isKilled("0xAAA"), true);
    assert.equal(kill.isKilled("0xBBB"), false); // el otro rig sigue
  });

  it("revive (dead:false) → desbloquea la pubkey, no cierra nada", () => {
    const { kill, closed } = rig({ live1: "0xAAA" });
    kill.setDead("live1", true);
    assert.equal(kill.setDead("live1", false), true);
    assert.equal(kill.isKilled("0xAAA"), false);
    assert.deepEqual(closed, ["0xAAA"]); // solo el kill cerró — revive no reabre (el forge reconecta solo)
  });

  it("instance desconocida → false honesto (404 upstream), nada matado", () => {
    const { kill, closed } = rig({ live1: "0xAAA" });
    assert.equal(kill.setDead("ghost", true), false);
    assert.equal(kill.setDead("ghost", false), false);
    assert.deepEqual(closed, []);
  });

  it("doble kill → idempotente, una sola closeSession", () => {
    const { kill, closed } = rig({ live1: "0xAAA" });
    kill.setDead("live1", true);
    // La instance sigue "visible" (pubkeyOf la resuelve): el segundo kill es
    // no-op sobre la sesión pero true — el forge ya está muerto, objetivo ok.
    assert.equal(kill.setDead("live1", true), true);
    assert.equal(kill.isKilled("0xAAA"), true);
    assert.deepEqual(closed, ["0xAAA"]);
  });

  it("kill → la instance sale de views → revive IGUAL funciona (mapping recordado)", () => {
    const owners = new Map([["live1", "0xAAA"]]);
    const closed: string[] = [];
    const kill = makeKillSwitch({ pubkeyOf: (id) => owners.get(id), closeSession: (pk) => closed.push(pk) });
    kill.setDead("live1", true);
    owners.delete("live1"); // la sesión murió → registry.unregister → pubkeyOf no resuelve
    // Segundo kill: nada que cerrar, pero el pubkey sigue bloqueado — honesto.
    assert.equal(kill.setDead("live1", true), true);
    assert.equal(kill.isKilled("0xAAA"), true);
    assert.deepEqual(closed, ["0xAAA"]);
    // Revive: el mapping recordado resuelve la pubkey → desbloqueo real.
    assert.equal(kill.setDead("live1", false), true);
    assert.equal(kill.isKilled("0xAAA"), false); // el forge ya puede reconectar
  });
});
