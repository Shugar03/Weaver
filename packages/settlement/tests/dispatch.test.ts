// packages/settlement/tests/dispatch.test.ts — SettleDispatcher: la vía de
// settle la decide el formato del worker (0x→EVM, G→Stellar), no un env
// global. Fleet mixta real: ambas vías configuradas → cada forge cobra en
// su chain; la vía no configurada → error explícito, jamás un cast ciego.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SettleDispatcher } from "../src/dispatch.ts";

type Call = { h: Buffer; sig: Buffer; worker?: string };
const fakeSettle = (label: string, calls: Call[]) => ({
  label,
  async settleJob(h: Buffer, sig: Buffer, worker?: string) {
    calls.push({ h, sig, worker });
    return { fundTx: `${label}-fund`, releaseTx: `${label}-release`, payout: 1 };
  },
});

const EVM_WORKER = "0x784E0a01c683df116fA5bb5A91180d6Fc06BF5CB";
const XLM_WORKER = "GBJCHUKZMTFSLOMNC7P4TS4VJJBTCYL3XKSOLXAUJSD56C4LHND5TWUC";
const H = Buffer.alloc(32, 1);
const SIG = Buffer.alloc(64, 2);

describe("SettleDispatcher", () => {
  it("worker 0x… → vía evm; worker G… → vía stellar", async () => {
    const evmCalls: Call[] = [];
    const xlmCalls: Call[] = [];
    const d = new SettleDispatcher({ evm: fakeSettle("evm", evmCalls), stellar: fakeSettle("xlm", xlmCalls) });
    await d.settleJob(H, SIG, EVM_WORKER);
    await d.settleJob(H, SIG, XLM_WORKER);
    assert.equal(evmCalls.length, 1);
    assert.equal(evmCalls[0].worker, EVM_WORKER);
    assert.equal(xlmCalls.length, 1);
    assert.equal(xlmCalls[0].worker, XLM_WORKER);
  });

  it("worker undefined (embedded) → vía default configurada", async () => {
    const evmCalls: Call[] = [];
    const xlmCalls: Call[] = [];
    const d = new SettleDispatcher({ evm: fakeSettle("evm", evmCalls), stellar: fakeSettle("xlm", xlmCalls), defaultChain: "stellar" });
    await d.settleJob(H, SIG, undefined);
    assert.equal(xlmCalls.length, 1);
    assert.equal(evmCalls.length, 0);
  });

  it("vía requerida no configurada → no-settler-for-format explícito", async () => {
    const d = new SettleDispatcher({ evm: fakeSettle("evm", []) });
    await assert.rejects(d.settleJob(H, SIG, XLM_WORKER), /no-settler-for-format/);
    // y la vía configurada sigue sirviendo
    await d.settleJob(H, SIG, EVM_WORKER);
  });

  it("formato irreconocible → error explícito, nunca un cast ciego", async () => {
    const d = new SettleDispatcher({ evm: fakeSettle("evm", []), stellar: fakeSettle("xlm", []) });
    await assert.rejects(d.settleJob(H, SIG, "not-an-address"), /worker-format/);
  });

  it("sin ninguna vía configurada → error en construcción, no en runtime", () => {
    assert.throws(() => new SettleDispatcher({}), /sin vías/);
  });
});
