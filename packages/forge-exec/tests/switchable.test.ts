// S7 — SwitchableExec delega vivo y throwea muerto.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SwitchableExec } from "../src/switchable.ts";
import { FakeForgeExec } from "../src/ports.ts";
import type { ForgeExec } from "../src/ports.ts";

async function collect(exec: ForgeExec): Promise<string> {
  let out = "";
  for await (const c of exec.execute({ jobId: "j", model: "qwen3:4b", prompt: "hola forge" })) out += c.token;
  return out;
}

describe("S7 switchable", () => {
  it("vivo → delega y espeja forgeId/model", async () => {
    const s = new SwitchableExec(new FakeForgeExec());
    assert.equal(s.forgeId, "fake-forge");
    assert.equal(await collect(s), "echo:hola forge");
  });

  it("muerto → throw; revivir → anda de nuevo", async () => {
    const s = new SwitchableExec(new FakeForgeExec());
    s.setDead(true);
    assert.equal(s.isDead(), true);
    await assert.rejects(collect(s), /chaos/);
    s.setDead(false);
    assert.ok((await collect(s)).includes("hola forge"));
  });
});
