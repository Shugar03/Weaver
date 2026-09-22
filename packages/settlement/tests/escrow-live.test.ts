// S17b — settleJob contra testnet real. Requiere TEST_SETTLEMENT_SECRET (admin
// GDQG…SMA) y TEST_WORKER_SECRET (forge que firma el proof L0); sin ellas, skip.
// Nota: release exitoso PRUEBA estado Released (el contrato revierte si la
// firma ed25519 del result_hash no es del worker registrado en init).
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import { EscrowSettlement, RpcSubmitter, stellarSigner } from "../src/escrow.ts";

const SECRET = process.env.TEST_SETTLEMENT_SECRET;
const WORKER_SECRET = process.env.TEST_WORKER_SECRET;
const CONTRACT = "CDHD6QRVGY5XNX6XUUYVCGJ6PH476J4YQXOSLJXH3RIPDRPW4PXWSENB";
const WORKER = "GDWZGZBSGDM2522KDT4MZZ6MGDDBTIX2CPFLXZMWMCWOHAPARTUZJX6T";

describe("S17b testnet vivo", () => {
  it("fund+release con proof L0 dejan 2 txs verificables", { skip: !SECRET || !WORKER_SECRET, timeout: 120000 }, async () => {
    const secret = SECRET as string;
    const operator = Keypair.fromSecret(secret).publicKey();
    const s = new EscrowSettlement(new RpcSubmitter("https://soroban-testnet.stellar.org", secret), {
      contractId: CONTRACT,
      operator,
      worker: WORKER,
      payout: 100000,
    });
    // El forge (worker) firma el sha256 de su output — el contrato lo verifica.
    const hash = createHash("sha256").update("live-proof-test").digest();
    const sig = stellarSigner(WORKER_SECRET as string)(hash);
    const r = await s.settleJob(hash, sig);
    assert.ok(r.jobId > 0);
    assert.match(r.fundTx, /^[0-9a-f]{64}$/);
    assert.match(r.releaseTx, /^[0-9a-f]{64}$/);
    console.log(`fund: https://stellar.expert/explorer/testnet/tx/${r.fundTx}`);
    console.log(`release: https://stellar.expert/explorer/testnet/tx/${r.releaseTx}`);
  });
});
