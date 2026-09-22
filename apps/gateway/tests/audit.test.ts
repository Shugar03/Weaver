// S38 — Auditor: replay probabilístico post-job contra referencia del mismo
// modelo. Reglas: mismatch = strike, N strikes → breaker; match limpia;
// auditor caído o sin referencia = skip (jamás penalizar por eso).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Auditor } from "../src/audit.ts";
import type { ForgeExec, StreamChunk } from "@weaver/forge-exec";
import type { ForgeView } from "@weaver/scheduler";

const view = (forgeId: string, extra: Partial<ForgeView> = {}): ForgeView => ({
  forgeId, model: "qwen3:4b", hot: true, rttMs: 1, queueMs: 0, loadTimeMs: 0,
  price: 0, reliability: 1, ...extra,
});

const execSaying = (forgeId: string, out: string): ForgeExec => ({
  forgeId,
  model: "qwen3:4b",
  async *execute(): AsyncIterable<StreamChunk> {
    yield { token: out, done: false };
    yield { token: "", done: true };
  },
});

const execThrowing = (forgeId: string): ForgeExec => ({
  forgeId,
  model: "qwen3:4b",
  async *execute(): AsyncIterable<StreamChunk> {
    throw new Error("cayó");
  },
});

const setup = (targetOut: string, refOut = "ok") => {
  const failed: string[] = [];
  const execs: Record<string, ForgeExec> = {
    remoto: execSaying("remoto", targetOut),
    ref: execSaying("ref", refOut),
  };
  const auditor = new Auditor({
    views: () => [view("remoto", { remote: true }), view("ref")],
    execOf: (id) => execs[id],
    breaker: { fail: (id) => failed.push(id) },
  });
  return { auditor, failed };
};

describe("S38 Auditor", () => {
  it("hashes iguales → match, sin strikes", async () => {
    const { auditor, failed } = setup("ok", "ok");
    assert.equal(await auditor.run("remoto", "qwen3:4b"), "match");
    assert.equal(failed.length, 0);
  });

  it("mismatch ×2 → strike-breaker; match intermedio limpia la racha", async () => {
    const { auditor, failed } = setup("miento!", "ok");
    assert.equal(await auditor.run("remoto", "qwen3:4b"), "mismatch");
    assert.equal(failed.length, 0); // un strike no tumba — falsos positivos existen
    assert.equal(await auditor.run("remoto", "qwen3:4b"), "strike-breaker");
    assert.deepEqual(failed, ["remoto"]);
  });

  it("un match limpia los strikes acumulados", async () => {
    const execs: Record<string, ForgeExec> = { remoto: execSaying("remoto", "A"), ref: execSaying("ref", "B") };
    const failed: string[] = [];
    const auditor = new Auditor({
      views: () => [view("remoto", { remote: true }), view("ref")],
      execOf: (id) => execs[id],
      breaker: { fail: (id) => failed.push(id) },
    });
    await auditor.run("remoto", "qwen3:4b"); // strike 1
    execs.remoto = execSaying("remoto", "B"); // ahora coincide
    assert.equal(await auditor.run("remoto", "qwen3:4b"), "match");
    execs.remoto = execSaying("remoto", "A"); // vuelve a mentir
    assert.equal(await auditor.run("remoto", "qwen3:4b"), "mismatch"); // strike 1 otra vez, no 2
    assert.equal(failed.length, 0);
  });

  it("sin referencia del modelo → skipped (no hay audit honesto)", async () => {
    const auditor = new Auditor({
      views: () => [view("remoto", { remote: true })], // solo él sirve el modelo
      execOf: () => execSaying("x", "ok"),
      breaker: { fail: () => assert.fail("no debería llegar") },
    });
    assert.equal(await auditor.run("remoto", "qwen3:4b"), "skipped");
  });

  it("auditor caído → skipped, el forge no paga la caída del auditor", async () => {
    const failed: string[] = [];
    const auditor = new Auditor({
      views: () => [view("remoto", { remote: true }), view("ref")],
      execOf: (id) => (id === "remoto" ? execThrowing(id) : execSaying(id, "ok")),
      breaker: { fail: (id) => failed.push(id) },
    });
    assert.equal(await auditor.run("remoto", "qwen3:4b"), "skipped");
    assert.equal(failed.length, 0);
  });

  it("forge saturado o no-attested → no es target ni referencia", async () => {
    const auditor = new Auditor({
      views: () => [
        view("remoto", { remote: true, saturated: true }),
        view("ref", { attested: false }),
      ],
      execOf: () => execSaying("x", "ok"),
      breaker: { fail: () => assert.fail("no debería llegar") },
    });
    assert.equal(await auditor.run("remoto", "qwen3:4b"), "skipped");
  });
});

describe("S38 anti-colusión", () => {
  it("toda la referencia del MISMO pubkey que el target → skipped", async () => {
    const failed: string[] = [];
    const execs: Record<string, ForgeExec> = {
      a1: execSaying("a1", "mentira"),
      a2: execSaying("a2", "ok"), // misma pubkey que a1 → cómplice, no referencia
    };
    const auditor = new Auditor({
      views: () => [
        view("a1", { remote: true, forgePubkey: "GPAAA" }),
        view("a2", { remote: true, forgePubkey: "GPAAA" }),
      ],
      execOf: (id) => execs[id],
      breaker: { fail: (id) => failed.push(id) },
    });
    assert.equal(await auditor.run("a1", "qwen3:4b"), "skipped");
    assert.equal(failed.length, 0);
  });

  it("referencia remota de OTRO pubkey → audit corre y detecta mismatch", async () => {
    const failed: string[] = [];
    const execs: Record<string, ForgeExec> = {
      a1: execSaying("a1", "mentira"),
      b1: execSaying("b1", "ok"),
    };
    const auditor = new Auditor({
      views: () => [
        view("a1", { remote: true, forgePubkey: "GPAAA" }),
        view("b1", { remote: true, forgePubkey: "GPBBB" }),
      ],
      execOf: (id) => execs[id],
      breaker: { fail: (id) => failed.push(id) },
    });
    assert.equal(await auditor.run("a1", "qwen3:4b"), "mismatch");
    assert.equal(await auditor.run("a1", "qwen3:4b"), "strike-breaker");
    assert.deepEqual(failed, ["a1"]);
  });
});

describe("S46 strikes persistidos", () => {
  it("un Auditor nuevo (restart simulado) hereda los strikes del store", async () => {
    const { InMemoryForgeStore } = await import("@weaver/forge-net");
    const store = new InMemoryForgeStore();
    await store.upsert({ pubkey: "GPAAA" });
    const failed: string[] = [];
    const execs: Record<string, ForgeExec> = {
      a1: execSaying("a1", "mentira"),
      ref: execSaying("ref", "ok"),
    };
    const mk = () =>
      new Auditor({
        views: () => [view("a1", { remote: true, forgePubkey: "GPAAA" }), view("ref")],
        execOf: (id) => execs[id],
        breaker: { fail: (id) => failed.push(id) },
        strikes: { add: (pk) => store.addStrike(pk), reset: (pk) => store.resetStrikes(pk) },
      });
    // boot 1: primer mismatch → strike persistido, sin breaker aún
    assert.equal(await mk().run("a1", "qwen3:4b"), "mismatch");
    assert.equal(failed.length, 0);
    // "restart": auditor nuevo, mismo store → el strike previo cuenta
    assert.equal(await mk().run("a1", "qwen3:4b"), "strike-breaker");
    assert.deepEqual(failed, ["a1"]);
  });
});
