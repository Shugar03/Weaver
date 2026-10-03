// ZDR (zero data retention): el prompt muere con el request. Test de
// invariante — un canario único viaja en el prompt y NO puede aparecer en
// ninguna superficie persistente: telemetría, settle on-chain, evidence
// ERC-8004, ledger de créditos (history) ni el result hash. Si mañana
// alguien loguea el prompt por accidente, este test explota.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.ts";
import { FakeForgeExec, ProvenForgeExec } from "@weaver/forge-exec";
import { InMemoryApiKeys } from "@weaver/api-keys";
import { InMemoryAccountStore, InMemoryCreditLedger, PricingBook } from "@weaver/accounts";
import { dualVerify, evmForgeKeypair, jobSettledFeedback } from "@weaver/settlement";
import type { Hex } from "viem";

const CANARY = "ZDR-CANARY-π9-secreto-que-no-debe-persistirse";
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const dirty = (x: unknown): boolean =>
  JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v)).includes(CANARY);

describe("ZDR — el prompt no persiste en ninguna superficie", () => {
  it("canario ausente de telemetría, settle, evidence ERC-8004 y ledger", async () => {
    const forge = evmForgeKeypair(KEY);
    const accounts = new InMemoryAccountStore();
    const ledger = new InMemoryCreditLedger();
    const keys = new InMemoryApiKeys();
    const pricing = new PricingBook({ "qwen3:4b": { prompt: 1000n, completion: 3000n, image: 0n } });
    const settleArgs: unknown[] = [];
    let feedback: ReturnType<typeof jobSettledFeedback> | undefined;
    const app = createApp({
      forges: () => [
        { forgeId: "f", model: "qwen3:4b", hot: true, rttMs: 1, queueMs: 0, loadTimeMs: 0, price: 0, reliability: 1 },
      ],
      exec: new ProvenForgeExec(new FakeForgeExec({ forgeId: "f" }), forge.sign),
      forgePubkeyOf: () => forge.address,
      verifyProof: dualVerify,
      settlement: {
        async settleJob(...args: unknown[]) {
          settleArgs.push(args);
          return { jobId: 9, fundTx: "0xf", releaseTx: "0xr" };
        },
      },
      onSettled: (r, _w, model) => {
        feedback = jobSettledFeedback(r, { agentId: 1n, model });
      },
      apiKeys: keys,
      accounts,
      ledger,
      pricing,
    });

    const { account } = await accounts.create();
    await ledger.credit(account.id, 10_000_000n, "topup:test");
    const { secret } = await keys.issue(account.id);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify({ model: "qwen3:4b", messages: [{ role: "user", content: CANARY }] }),
    });
    await res.text();
    assert.equal(res.status, 200);

    const deadline = Date.now() + 3000;
    let execs: unknown[] = [];
    while (execs.length === 0 && Date.now() < deadline) {
      execs = (await (await app.request("/v1/executions")).json()) as unknown[];
      if (execs.length === 0) await new Promise((r) => setTimeout(r, 25));
    }
    // El debit es fire-and-forget post-close — le deja un tick.
    await new Promise((r) => setTimeout(r, 60));

    assert.ok(!dirty(execs), "telemetría filtró el prompt");
    assert.ok(!dirty(settleArgs), "settleJob recibió el prompt");
    assert.ok(!dirty(feedback), "evidence ERC-8004 lleva el prompt");
    assert.ok(!dirty(await ledger.history(account.id)), "ledger history lleva el prompt");
    // El result hash es sha256(output) — jamás del prompt:
    assert.ok(!(settleArgs[0] as Buffer[])[0].toString().includes(CANARY), "result hash contiene prompt");
  });
});
