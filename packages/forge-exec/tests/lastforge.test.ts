// S9a — FailoverForgeExec recuerda quién sirvió (para telemetry honesta).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FailoverForgeExec } from "../src/failover.ts";
import { FakeForgeExec } from "../src/ports.ts";
import type { ForgeExec } from "../src/ports.ts";

class DeadExec implements ForgeExec {
  readonly forgeId = "dead";
  readonly model = "qwen3:4b";
  async *execute(): AsyncIterable<{ token: string; done: boolean }> {
    throw new Error("caído");
  }
}

async function drain(exec: ForgeExec): Promise<void> {
  for await (const _ of exec.execute({ jobId: "j", model: "qwen3:4b", prompt: "h" })) {
    /* drenar */
  }
}

describe("S9a lastForgeId", () => {
  it("apunta al que sirvió tras failover", async () => {
    const f = new FailoverForgeExec([new DeadExec(), new FakeForgeExec({ forgeId: "segundo" })]);
    assert.equal(f.lastForgeId, null);
    await drain(f);
    assert.equal(f.lastForgeId, "segundo");
  });
});
