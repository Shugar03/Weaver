// ADR-0008 — EvmDepositWatcher: poll Deposited logs de WeaverCredits,
// bytes32(utf8 acct_…) → cuenta, dedup por txHash:logIndex (replay-safe),
// errores RPC no tumban el loop.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EvmDepositWatcher,
  DEPOSITED_TOPIC,
  accountToBytes32,
  bytes32ToAccount,
  type EvmLog,
} from "../src/evmwatcher.ts";
import { InMemoryAccountStore } from "../src/store.ts";
import { InMemoryCreditLedger } from "../src/ledger.ts";

const CREDITS = "0xd14957AE85C4FA10fd5AB9f0d17f1cFcE2C0A498" as const;

const deposit = (accountId: string, amount: bigint, tx: string, bn: bigint, logIndex = 0): EvmLog => ({
  topics: [DEPOSITED_TOPIC, accountToBytes32(accountId), `0x${"0".repeat(24)}${"a".repeat(40)}`],
  data: `0x${amount.toString(16).padStart(64, "0")}`,
  transactionHash: tx,
  blockNumber: bn,
  logIndex,
});

describe("EVM accountToBytes32/bytes32ToAccount", () => {
  it("roundtrip acct_ id", () => {
    const id = "acct_lx3k2_AbCdEf";
    assert.equal(bytes32ToAccount(accountToBytes32(id)), id);
  });
  it("rechaza ids >31 bytes y decodificaciones no-acct", () => {
    assert.throws(() => accountToBytes32("x".repeat(40)));
    assert.equal(bytes32ToAccount(accountToBytes32("")), null);
    assert.equal(bytes32ToAccount("0x" + "ff".repeat(32)), null);
  });
});

describe("EVM DepositWatcher", () => {
  it("Deposited con account acct_ → acredita en stroops (USDC 6dec ×10)", async () => {
    const store = new InMemoryAccountStore();
    const ledger = new InMemoryCreditLedger();
    const { account } = await store.create();
    const w = new EvmDepositWatcher({
      credits: CREDITS,
      store,
      ledger,
      fetcher: async () => [deposit(account.id, 25_000_000n, "0xtx1", 100n)],
      pollMs: 999_999,
    });
    await w.pollOnce();
    // 25 USDC (25e6 units 6dec) → 250e6 stroops (7dec). Acreditar el amount
    // crudo era dar el 10% del depósito (bug medido live en spec 016).
    assert.equal(await ledger.balance(account.id), 250_000_000n);
  });

  it("dedup por txHash:logIndex — re-poll del mismo log no duplica", async () => {
    const store = new InMemoryAccountStore();
    const ledger = new InMemoryCreditLedger();
    const { account } = await store.create();
    const log = deposit(account.id, 10_000_000n, "0xtx1", 100n);
    const w = new EvmDepositWatcher({
      credits: CREDITS, store, ledger,
      fetcher: async () => [log], pollMs: 999_999,
    });
    await w.pollOnce();
    await w.pollOnce(); // mismo log otra vez — cursor 100, se re-entrega
    assert.equal(await ledger.balance(account.id), 100_000_000n); // ×10 stroops
  });

  it("accountId desconocido → log, sin acreditar, cursor igual avanza", async () => {
    const store = new InMemoryAccountStore();
    const ledger = new InMemoryCreditLedger();
    const seen: string[] = [];
    const w = new EvmDepositWatcher({
      credits: CREDITS, store, ledger,
      onEvent: (m) => seen.push(m),
      fetcher: async () => [deposit("acct_ghost_xx", 1n, "0xtx9", 50n)],
      pollMs: 999_999,
    });
    await w.pollOnce();
    assert.ok(seen.some((m) => m.includes("sin cuenta")));
  });

  it("fetcher que falla → log y sigue vivo", async () => {
    const store = new InMemoryAccountStore();
    const ledger = new InMemoryCreditLedger();
    let calls = 0;
    const { account } = await store.create();
    const w = new EvmDepositWatcher({
      credits: CREDITS, store, ledger,
      fetcher: async () => {
        calls++;
        if (calls === 1) throw new Error("rpc down");
        return [deposit(account.id, 5n, "0xtx2", 7n)];
      },
      pollMs: 999_999,
    });
    await w.pollOnce();
    await w.pollOnce();
    assert.equal(await ledger.balance(account.id), 50n); // ×10 stroops
  });

  it("multi-log en la misma tx: dedup por txHash:logIndex acredita ambos", async () => {
    const store = new InMemoryAccountStore();
    const ledger = new InMemoryCreditLedger();
    const { account } = await store.create();
    const w = new EvmDepositWatcher({
      credits: CREDITS, store, ledger,
      fetcher: async () => [
        deposit(account.id, 3n, "0xtxM", 10n, 0),
        deposit(account.id, 7n, "0xtxM", 10n, 1), // mismo tx, otro logIndex
      ],
      pollMs: 999_999,
    });
    await w.pollOnce();
    await w.pollOnce(); // replay: no duplica
    assert.equal(await ledger.balance(account.id), 100n); // (3+7) ×10 stroops
  });

  it("reorg: log con removed:true jamás acredita", async () => {
    const store = new InMemoryAccountStore();
    const ledger = new InMemoryCreditLedger();
    const { account } = await store.create();
    const w = new EvmDepositWatcher({
      credits: CREDITS, store, ledger,
      fetcher: async () => [{ ...deposit(account.id, 99n, "0xtxR", 10n), removed: true }],
      pollMs: 999_999,
    });
    await w.pollOnce();
    assert.equal(await ledger.balance(account.id), 0n);
  });

  it("log de bloque viejo (< cursor) se salta — no reacredita tras seek atrás", async () => {
    const store = new InMemoryAccountStore();
    const ledger = new InMemoryCreditLedger();
    const { account } = await store.create();
    const w = new EvmDepositWatcher({
      credits: CREDITS, store, ledger, fromBlock: 100n,
      fetcher: async () => [deposit(account.id, 4n, "0xtxOld", 50n)], // bn 50 < cursor 100
      pollMs: 999_999,
    });
    await w.pollOnce();
    assert.equal(await ledger.balance(account.id), 0n);
  });
});
