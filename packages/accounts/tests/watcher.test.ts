// S47 (ADR-0007) — DepositWatcher: poll Horizon payments, memo→cuenta,
// dedup por op.id (replay/crash-safe), errores no tumban el loop.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DepositWatcher, type HorizonPage } from "../src/watcher.ts";
import { InMemoryAccountStore } from "../src/store.ts";
import { InMemoryCreditLedger } from "../src/ledger.ts";

const DEPOSIT_ADDR = "GDEPOSIT";
const USDC_ISSUER = "GISSUER";

const pay = (id: string, amount: string, memo?: string, asset = "USDC") => ({
  id,
  paging_token: id,
  type: "payment",
  to: DEPOSIT_ADDR,
  asset_code: asset,
  asset_issuer: USDC_ISSUER,
  amount,
  transaction: { hash: `tx${id}`, memo_type: memo ? "text" : "none", memo },
});
const page = (...records: unknown[]): HorizonPage => ({ _embedded: { records: records as never[] } });

describe("S47 DepositWatcher", () => {
  it("payment USDC con memo de cuenta → acredita stroops exactos", async () => {
    const store = new InMemoryAccountStore();
    const ledger = new InMemoryCreditLedger();
    const { account } = await store.create();
    const w = new DepositWatcher({
      horizonUrl: "h", depositAddress: DEPOSIT_ADDR, assetCode: "USDC", assetIssuer: USDC_ISSUER,
      store, ledger, fetcher: async () => page(pay("100", "2.5", account.id)), pollMs: 999_999,
    });
    await w.pollOnce();
    assert.equal(await ledger.balance(account.id), 25_000_000n); // 2.5 USDC
  });

  it("dedup por op.id: re-poll no duplica; memo desconocido/wrong asset/otro destino → skip", async () => {
    const store = new InMemoryAccountStore();
    const ledger = new InMemoryCreditLedger();
    const { account } = await store.create();
    // Horizon devuelve DESC (newest first) — el fake replica ese orden.
    const ops = [
      { ...pay("14", "5.0", account.id), type: "manage_offer" }, // no es payment
      { ...pay("13", "5.0", account.id), to: "GOTRO" }, // otro destino
      { ...pay("12", "5.0", account.id), asset_code: "XLM" }, // otro asset
      pay("11", "9.9", "acct_inexistente"),
      pay("10", "1.0", account.id),
    ];
    const w = new DepositWatcher({
      horizonUrl: "h", depositAddress: DEPOSIT_ADDR, assetCode: "USDC", assetIssuer: USDC_ISSUER,
      store, ledger, fetcher: async () => page(...ops), pollMs: 999_999,
    });
    await w.pollOnce();
    assert.equal(await ledger.balance(account.id), 10_000_000n);
    await w.pollOnce(); // mismo fetch → mismos ops → dedup
    await w.pollOnce();
    assert.equal(await ledger.balance(account.id), 10_000_000n);
  });

  it("memo de wallet G... resuelve la cuenta linkeada; outage no tira el loop", async () => {
    const store = new InMemoryAccountStore();
    const ledger = new InMemoryCreditLedger();
    const a = await store.createForWallet("G" + "W".repeat(55));
    let fail = true;
    const w = new DepositWatcher({
      horizonUrl: "h", depositAddress: DEPOSIT_ADDR, assetCode: "USDC", assetIssuer: USDC_ISSUER,
      store, ledger,
      fetcher: async () => {
        if (fail) throw new Error("horizon caído");
        return page(pay("20", "1.5", "G" + "W".repeat(55)));
      },
      pollMs: 999_999,
    });
    await w.pollOnce(); // outage → no acredita, no throw
    assert.equal(await ledger.balance(a.id), 0n);
    fail = false;
    await w.pollOnce();
    assert.equal(await ledger.balance(a.id), 15_000_000n);
    await w.stop();
  });
});
