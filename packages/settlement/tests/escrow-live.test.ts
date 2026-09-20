// S17b — settleJob contra testnet real. Requiere TEST_SETTLEMENT_SECRET
// (secret del admin GDQG…SMA, jamás en repo); sin ella, skip.
// Nota: release exitoso PRUEBA estado Released (el contrato revierte si no).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import { EscrowSettlement, RpcSubmitter } from "../src/escrow.ts";

const SECRET = process.env.TEST_SETTLEMENT_SECRET;
const CONTRACT = "CDPOGSQLTLRZPCE2NF4WFVSMGQEGLOAPBM5LFCK2U26LP6B5YVN5GBU3";
const WORKER = "GDWZGZBSGDM2522KDT4MZZ6MGDDBTIX2CPFLXZMWMCWOHAPARTUZJX6T";

describe("S17b testnet vivo", () => {
  it("fund+release dejan 2 txs verificables", { skip: !SECRET, timeout: 120000 }, async () => {
    const secret = SECRET as string;
    const operator = Keypair.fromSecret(secret).publicKey();
    const s = new EscrowSettlement(new RpcSubmitter("https://soroban-testnet.stellar.org", secret), {
      contractId: CONTRACT,
      operator,
      worker: WORKER,
      payout: 100000,
    });
    const r = await s.settleJob();
    assert.ok(r.jobId > 0);
    assert.match(r.fundTx, /^[0-9a-f]{64}$/);
    assert.match(r.releaseTx, /^[0-9a-f]{64}$/);
    console.log(`fund: https://stellar.expert/explorer/testnet/tx/${r.fundTx}`);
    console.log(`release: https://stellar.expert/explorer/testnet/tx/${r.releaseTx}`);
  });
});
