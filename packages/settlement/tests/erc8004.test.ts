// ERC-8004 — forgeAgentURI/jobSettledFeedback puros + register/giveFeedback
// contra el seam fake (misma técnica que evm-escrow.test.ts).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ERC8004_IDENTITY,
  ERC8004_REPUTATION,
  forgeAgentURI,
  giveFeedback,
  jobSettledFeedback,
  registerAgent,
} from "../src/erc8004.ts";
import type { Address, Hex } from "viem";

const WORKER = "0x7c41eb4274b7e5C51e44BA01606d9Db403BBbebc" as Address;

function fakeInvoker(calls: { contract: string; fn: string; args: unknown[] }[]) {
  return {
    async invoke(contract: Address, _abi: readonly unknown[], fn: string, args: unknown[]) {
      calls.push({ contract, fn, args });
      if (fn === "register") return { txHash: "0xreg" as Hex, retval: 42n };
      return { txHash: "0xfb" as Hex };
    },
  };
}

describe("ERC-8004 forgeAgentURI", () => {
  it("data URI JSON con identidad del forge — sin prompts ni datos privados", () => {
    const uri = forgeAgentURI({ name: "forge-alpha", model: "qwen3-32b", worker: WORKER });
    assert.ok(uri.startsWith("data:application/json;base64,"));
    const doc = JSON.parse(Buffer.from(uri.split(",")[1], "base64").toString());
    assert.equal(doc.name, "forge-alpha");
    assert.equal(doc.weaver.worker, WORKER);
    assert.equal(doc.registrations[0].agentRegistry, `eip155:10143:${ERC8004_IDENTITY}`);
  });
});

describe("ERC-8004 register/giveFeedback via seam", () => {
  it("register → Identity registry, devuelve agentId del retval", async () => {
    const calls: { contract: string; fn: string; args: unknown[] }[] = [];
    const r = await registerAgent(fakeInvoker(calls), "data:application/json,{}");
    assert.equal(calls[0].contract, ERC8004_IDENTITY);
    assert.equal(calls[0].fn, "register");
    assert.equal(r.agentId, 42n);
    assert.equal(r.txHash, "0xreg");
  });

  it("giveFeedback → Reputation registry con los 8 args del v2", async () => {
    const calls: { contract: string; fn: string; args: unknown[] }[] = [];
    await giveFeedback(fakeInvoker(calls), { agentId: 42n, value: 1n, tag1: "jobSettled", tag2: "qwen3" });
    assert.equal(calls[0].contract, ERC8004_REPUTATION);
    assert.equal(calls[0].fn, "giveFeedback");
    assert.equal(calls[0].args.length, 8);
    assert.equal(calls[0].args[0], 42n);
    assert.equal(calls[0].args[1], 1n);
    assert.equal(calls[0].args[3], "jobSettled");
    assert.equal(calls[0].args[4], "qwen3");
  });

  it("jobSettledFeedback: evidencia = recibo del escrow (jobId+txs+hash)", () => {
    const f = jobSettledFeedback(
      { jobId: 7, fundTx: "0xfund", releaseTx: "0xrel" },
      { agentId: 42n, model: "qwen3-32b", resultHash: Buffer.alloc(32, 7) },
    );
    assert.equal(f.agentId, 42n);
    assert.equal(f.tag1, "jobSettled");
    const ev = JSON.parse(decodeURIComponent(f.feedbackURI!.split(",")[1]));
    assert.equal(ev.jobId, 7);
    assert.equal(ev.releaseTx, "0xrel");
    assert.equal(ev.resultHash, `0x${"07".repeat(32)}`);
  });
});
