// S17b/S42 — settleJob contra testnet real, contrato v4 (worker ligado en
// fund_job, self-claim habilitado). Requiere:
//   TEST_SETTLEMENT_SECRET  secret del operador (fondea jobs, admin o caller)
//   TEST_WORKER_SECRET      secret del forge (firma el proof L0 + se registra)
//   TEST_CONTRACT           contract id del escrow v4 deployado
//   TEST_TOKEN              contract id del SAC de pago (para assert de balance)
// Sin ellas → skip. Prueba la pregunta real: ¿el balance del worker SUBE?
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Address,
  Contract,
  Keypair,
  nativeToScVal,
  Networks,
  rpc,
  scValToNative,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { EscrowSettlement, RpcSubmitter, stellarSigner } from "../src/escrow.ts";

const SECRET = process.env.TEST_SETTLEMENT_SECRET;
const WORKER_SECRET = process.env.TEST_WORKER_SECRET;
const CONTRACT = process.env.TEST_CONTRACT;
const TOKEN = process.env.TEST_TOKEN;
const RPC_URL = process.env.SOROBAN_RPC ?? "https://soroban-testnet.stellar.org";
const PAYOUT = 100000; // $0.01 USDC (7 decimales)

const skip = !SECRET || !WORKER_SECRET || !CONTRACT || !TOKEN;

// Balance del SAC por simulación — read-only, no consume secuencia ni fees.
async function tokenBalance(server: rpc.Server, source: string, who: string): Promise<bigint> {
  const acc = await server.getAccount(source);
  const tx = new TransactionBuilder(acc, { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(new Contract(TOKEN as string).call("balance", new Address(who).toScVal()))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim)) throw new Error("simulate balance falló");
  return BigInt(scValToNative(sim.result!.retval) as bigint);
}

describe("S42 testnet vivo — contrato v4", () => {
  it(
    "register → fund → release → el balance del worker sube el payout exacto",
    { skip, timeout: 240000 },
    async () => {
      const secret = SECRET as string;
      const workerKp = Keypair.fromSecret(WORKER_SECRET as string);
      const worker = workerKp.publicKey();
      const server = new rpc.Server(RPC_URL);

      // 1) Self-registration: el forge firma su propio register_forge
      //    (worker.require_auth). Friendbot si la cuenta no existe aún.
      const workerSubmitter = new RpcSubmitter(RPC_URL, WORKER_SECRET as string);
      const regArgs = () => [
        new Address(worker).toScVal(),
        nativeToScVal(Buffer.from(workerKp.rawPublicKey())),
      ];
      try {
        await workerSubmitter.invoke(CONTRACT as string, "register_forge", regArgs());
      } catch (e) {
        if (!String(e).match(/not.found|no.account|404/i)) throw e;
        await fetch(`https://friendbot.stellar.org?addr=${worker}`);
        await workerSubmitter.invoke(CONTRACT as string, "register_forge", regArgs());
      }

      // 2) Settle completo: fund_job liga al worker, release verifica su firma.
      const before = await tokenBalance(server, worker, worker);
      const s = new EscrowSettlement(new RpcSubmitter(RPC_URL, secret), {
        contractId: CONTRACT as string,
        operator: Keypair.fromSecret(secret).publicKey(),
        worker,
        payout: PAYOUT,
      });
      const hash = createHash("sha256").update(`live-${Date.now()}`).digest();
      const sig = stellarSigner(WORKER_SECRET as string)(hash);
      const r = await s.settleJob(hash, sig, worker);

      assert.ok(r.jobId > 0);
      assert.match(r.fundTx, /^[0-9a-f]{64}$/);
      assert.match(r.releaseTx, /^[0-9a-f]{64}$/);

      // 3) La prueba de verdad: el worker cobró EXACTAMENTE el payout.
      const after = await tokenBalance(server, worker, worker);
      assert.equal(after - before, BigInt(PAYOUT));

      // 4) Doble release → tx falla (la máquina de estados no paga dos veces).
      const operator = new RpcSubmitter(RPC_URL, secret);
      await assert.rejects(() =>
        operator.invoke(CONTRACT as string, "release", [
          new Address(Keypair.fromSecret(secret).publicKey()).toScVal(),
          nativeToScVal(r.jobId, { type: "u64" }),
          nativeToScVal(hash),
          nativeToScVal(sig),
        ]),
      );

      console.log(`fund: https://stellar.expert/explorer/testnet/tx/${r.fundTx}`);
      console.log(`release: https://stellar.expert/explorer/testnet/tx/${r.releaseTx}`);
      console.log(`worker cobró ${PAYOUT} stroops (Δ on-chain confirmado)`);
    },
  );
});
