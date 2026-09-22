// S47 (ADR-0007) — AccountStore: create/login mgmt, wallet link, sesiones.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InMemoryAccountStore } from "../src/store.ts";
import { accountByMemo, depositMemoFor } from "../src/deposit.ts";

describe("S47 AccountStore", () => {
  it("create → cuenta + mgmt token mostrado una vez; byMgmtToken resuelve", async () => {
    const s = new InMemoryAccountStore();
    const { account, mgmtToken } = await s.create();
    assert.match(account.id, /^acct_/);
    assert.match(mgmtToken, /^wvr_acct_/);
    assert.equal((await s.byMgmtToken(mgmtToken))?.id, account.id);
    assert.equal(await s.byMgmtToken("wvr_acct_trucho"), null);
    assert.equal(await s.byMgmtToken("wvr_otra_cosa"), null);
    assert.equal(await s.byMgmtToken(""), null);
  });

  it("wallet: createForWallet + byWallet + linkWallet unifican identidad", async () => {
    const s = new InMemoryAccountStore();
    const w = await s.createForWallet("GABC");
    assert.equal((await s.byWallet("GABC"))?.id, w.id);
    const { account } = await s.create();
    await s.linkWallet(account.id, "GXYZ");
    assert.equal((await s.byWallet("GXYZ"))?.id, account.id);
    assert.equal((await s.get(account.id))?.walletPubkey, "GXYZ");
    assert.equal(await s.byWallet("GNADA"), null);
  });

  it("sesiones: issueSession → bySession válida; token ajeno → null", async () => {
    const s = new InMemoryAccountStore();
    const { account } = await s.create();
    const { token, expiresAt } = await s.issueSession(account.id);
    assert.match(token, /^wvr_sess_/);
    assert.ok(expiresAt > Date.now());
    assert.equal((await s.bySession(token))?.id, account.id);
    assert.equal(await s.bySession("wvr_sess_falso"), null);
    assert.equal(await s.bySession("wvr_acct_noes"), null);
  });

  it("deposit memo: id de cuenta ≤28 chars; accountByMemo resuelve id y wallet", async () => {
    const s = new InMemoryAccountStore();
    const { account } = await s.create();
    const memo = depositMemoFor(account);
    assert.equal(memo, account.id);
    assert.ok(memo.length <= 28);
    assert.equal((await accountByMemo(s, memo))?.id, account.id);
    // wallet linkeada → el memo de depósito puede ser la pubkey G... también
    await s.linkWallet(account.id, "G" + "A".repeat(55));
    assert.equal((await accountByMemo(s, "G" + "A".repeat(55)))?.id, account.id);
    assert.equal(await accountByMemo(s, "basura"), null);
    assert.equal(await accountByMemo(s, ""), null);
  });
});
