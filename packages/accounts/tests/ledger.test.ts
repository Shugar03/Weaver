// S47 (ADR-0007) — CreditLedger: topup/debit idempotente, balance exacto.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InMemoryCreditLedger } from "../src/ledger.ts";

describe("S47 CreditLedger", () => {
  it("topup acredita; mismo ref no duplica (replay de watcher seguro)", async () => {
    const l = new InMemoryCreditLedger();
    assert.equal(await l.credit("acct_1", 1_000_000n, "tx-abc"), true);
    assert.equal(await l.credit("acct_1", 1_000_000n, "tx-abc"), false);
    assert.equal(await l.balance("acct_1"), 1_000_000n);
    // mismo ref en OTRA kind sí puede coexistir (dedup es por kind+ref)
    assert.equal(await l.debit("acct_1", 100n, "tx-abc"), true);
  });

  it("debit resta; mismo jobId no debita dos veces; balance puede ir negativo", async () => {
    const l = new InMemoryCreditLedger();
    await l.credit("acct_1", 500_000n, "tx1");
    assert.equal(await l.debit("acct_1", 300_000n, "job-1"), true);
    assert.equal(await l.debit("acct_1", 300_000n, "job-1"), false);
    assert.equal(await l.balance("acct_1"), 200_000n);
    // A3: un serve ya iniciado debita aunque supere el balance — visible.
    await l.debit("acct_1", 400_000n, "job-2");
    assert.equal(await l.balance("acct_1"), -200_000n);
    const h = await l.history("acct_1");
    assert.equal(h.length, 3);
    assert.deepEqual(h.map((e) => e.kind), ["topup", "debit", "debit"]);
  });

  it("montos <= 0 jamás mutan el ledger; aislamiento entre cuentas", async () => {
    const l = new InMemoryCreditLedger();
    assert.equal(await l.credit("a", 0n, "r"), false);
    assert.equal(await l.debit("a", -5n, "r"), false);
    assert.equal(await l.balance("a"), 0n);
    await l.credit("a", 10n, "x");
    await l.credit("b", 99n, "y");
    assert.equal(await l.balance("a"), 10n);
    assert.equal(await l.balance("b"), 99n);
  });
});
