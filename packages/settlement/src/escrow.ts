// Module Settlement — escrow programático (S17b). El operador fondea cada job
// y libera al worker contra resultado. Dos piezas:
// - ChainSubmitter: transporta una invocación (fake en tests, RPC en prod).
// - EscrowSettlement: el loop fund→release, sin saber de HTTP ni wallets en claro.
import {
  Address,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  type xdr,
} from "@stellar/stellar-sdk";

export type ChainSubmitter = {
  invoke(contractId: string, fn: string, args: xdr.ScVal[]): Promise<{ txHash: string; retval?: xdr.ScVal }>;
};

export type EscrowConfig = {
  contractId: string;
  operator: string; // G... admin: el único que release() acepta como caller
  worker: string; // G... que cobra
  payout: number; // i128 en stroops de USDC (100000 = $0.01)
};

export type SettleReceipt = { jobId: number; fundTx: string; releaseTx: string };

const PAYOUT_MAX = 10_000_000; // 1 USDC: techo anti-typo (nunca drena de más)

export class EscrowSettlement {
  private submitter: ChainSubmitter;
  private cfg: EscrowConfig;

  constructor(submitter: ChainSubmitter, cfg: EscrowConfig) {
    this.submitter = submitter;
    this.cfg = cfg;
    if (!Number.isInteger(cfg.payout) || cfg.payout <= 0 || cfg.payout > PAYOUT_MAX) {
      throw new Error(`payout inválido: ${cfg.payout}`);
    }
  }

  async settleJob(): Promise<SettleReceipt> {
    const { contractId, operator, worker, payout } = this.cfg;
    const funded = await this.submitter.invoke(contractId, "fund_job", [
      new Address(operator).toScVal(),
      nativeToScVal(payout, { type: "i128" }),
    ]);
    const jobId = Number(scValToNative(funded.retval as xdr.ScVal));
    const released = await this.submitter.invoke(contractId, "release", [
      new Address(operator).toScVal(),
      nativeToScVal(jobId, { type: "u64" }),
      new Address(worker).toScVal(),
    ]);
    return { jobId, fundTx: funded.txHash, releaseTx: released.txHash };
  }
}

// Submit real: simula→firma→envía→espera SUCCESS. Secret jamás sale de acá.
export class RpcSubmitter implements ChainSubmitter {
  private server: rpc.Server;
  private keypair: Keypair;

  constructor(rpcUrl: string, secret: string) {
    this.server = new rpc.Server(rpcUrl);
    this.keypair = Keypair.fromSecret(secret);
  }

  async invoke(
    contractId: string,
    fn: string,
    args: xdr.ScVal[],
  ): Promise<{ txHash: string; retval?: xdr.ScVal }> {
    const source = await this.server.getAccount(this.keypair.publicKey());
    const op = Operation.invokeContractFunction({ contract: contractId, function: fn, args });
    const built = new TransactionBuilder(source, {
      fee: "10000",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();
    // La simulación da el returnValue (jobId del fund) ANTES de firmar.
    const sim = await this.server.simulateTransaction(built);
    if (rpc.Api.isSimulationError(sim)) {
      throw new Error(`simulate ${fn}: ${JSON.stringify(sim.error)}`);
    }
    const prepared = await this.server.prepareTransaction(built);
    prepared.sign(this.keypair);
    const sent = await this.server.sendTransaction(prepared);
    if (sent.status === "ERROR") {
      throw new Error(`submit ${fn}: ${JSON.stringify(sent.errorResult)}`);
    }
    const hash = sent.hash;
    const deadline = Date.now() + 30000;
    for (;;) {
      const got = await this.server.getTransaction(hash);
      if (got.status === "SUCCESS") {
        const retval = sim.result?.retval;
        return retval ? { txHash: hash, retval } : { txHash: hash };
      }
      if (got.status === "FAILED" || Date.now() > deadline) {
        throw new Error(`tx ${fn} ${got.status}: ${hash}`);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
