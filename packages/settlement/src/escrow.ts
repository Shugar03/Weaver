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
import { SerialQueue } from "./queue.ts";
import type { PendingSettle, SettleJournal } from "./journal.ts";

// S44 (I3): sweep de escrows pending — re-liquida lo que quedó funded
// (crash entre fund y release). El proof sigue válido; si la tx revierte
// queda markFailed visible. Devuelve cuántos se recuperaron.
export async function sweepPendingSettles(
  submitter: ChainSubmitter,
  journal: SettleJournal,
  contractId: string,
  caller: string,
): Promise<{ released: number; failed: number }> {
  const pend = await journal.pending();
  let released = 0;
  let failed = 0;
  for (const p of pend) {
    try {
      const r = await submitter.invoke(contractId, "release", [
        new Address(caller).toScVal(),
        nativeToScVal(p.jobId, { type: "u64" }),
        nativeToScVal(Buffer.from(p.resultHash, "hex")),
        nativeToScVal(Buffer.from(p.forgeSig, "hex")),
      ]);
      await journal.markReleased(p.jobId, r.txHash);
      released++;
    } catch (e) {
      // Solo errores TERMINALES del contrato sacan el job del pending —
      // un timeout/sequence/RPC caído es transitorio: queda pending y el
      // próximo boot lo reintenta (el proof no expira).
      if (isTerminalReleaseError(e)) {
        await journal.markFailed(p.jobId, String(e)).catch(() => {});
        failed++;
      } else {
        console.warn(`sweep: release transitorio falló (job ${p.jobId}, sigue pending):`, e);
      }
    }
  }
  return { released, failed };
}

// Errores del enum Error del contrato — revert on-chain = estado conocido,
// reintentar no cambiaría el resultado. Todo lo demás es transitorio.
const TERMINAL = /BadState|Unauthorized|ForgeNotFound|BadAmount|NotInitialized|JobNotFound|AlreadyInitialized/;
export function isTerminalReleaseError(e: unknown): boolean {
  return TERMINAL.test(String(e));
}

// S42: register_forge on-chain vía el seam ChainSubmitter — caller debe ser
// el worker (require_auth) o admin. Idempotente: re-invocar renueva el TTL.
export async function registerForge(
  submitter: ChainSubmitter,
  contractId: string,
  worker: string,
): Promise<string> {
  const { txHash } = await submitter.invoke(contractId, "register_forge", [
    new Address(worker).toScVal(),
    nativeToScVal(Buffer.from(Keypair.fromPublicKey(worker).rawPublicKey())),
  ]);
  return txHash;
}

export type ChainSubmitter = {
  invoke(contractId: string, fn: string, args: xdr.ScVal[]): Promise<{ txHash: string; retval?: xdr.ScVal }>;
};

export type EscrowConfig = {
  contractId: string;
  operator: string; // G... admin: release() lo acepta como caller
  worker: string; // G... default (embedded/legacy); remoto pasa el suyo
  payout: number; // base en stroops de USDC (100000 = $0.01)
  perToken?: number; // S45: stroops por genToken medido — pago ∝ trabajo
};

export type SettleReceipt = { jobId: number; fundTx: string; releaseTx: string };

// S45 (ADR-0006, I5): pago ∝ trabajo medido. genTokens viene del frame done
// del engine — medido, no declarado. Techo PAYOUT_MAX siempre.
export function payoutFor(
  stats: { genTokens?: number } | null | undefined,
  cfg: { base: number; perToken: number },
): number {
  const n = cfg.base + Math.max(0, stats?.genTokens ?? 0) * cfg.perToken;
  return Math.min(PAYOUT_MAX, Math.round(n));
}

// S23: firma ed25519 Stellar para Proof L0 (Keypair.sign = ed25519 puro).
// Vive acá porque settlement es quien posee stellar-sdk; forge-exec recibe una
// función `sign(hash) => Buffer` y nunca ve la librería.
export function stellarSigner(secret: string): (msg: Buffer) => Buffer {
  const kp = Keypair.fromSecret(secret);
  return (msg) => Buffer.from(kp.sign(msg));
}

// S32: verificación ed25519 por pubkey — el handshake del forge remoto firma
// el nonce con SU secret; el gateway solo necesita el pubkey para verificar.
// Pubkey inválido / firma inválida → false (jamás throw por input remoto).
export function stellarVerify(pubkey: string, msg: Buffer, sig: Buffer): boolean {
  try {
    return Keypair.fromPublicKey(pubkey).verify(msg, sig);
  } catch {
    return false;
  }
}

// S42: la cuenta operadora DERIVA de la secret — jamás un G... hardcodeado que
// pueda desalinearse del keypair que firma (mismatch = toda tx sin auth).
export function stellarPubkey(secret: string): string {
  return Keypair.fromSecret(secret).publicKey();
}

// S47: keypair random para tests/dev — el SDK queda dentro de settlement,
// los consumidores no importan @stellar/stellar-sdk directo.
export function stellarKeypair(): { pubkey: string; secret: string; sign(msg: Buffer): Buffer } {
  const kp = Keypair.random();
  return { pubkey: kp.publicKey(), secret: kp.secret(), sign: (m) => Buffer.from(kp.sign(m)) };
}

const PAYOUT_MAX = 10_000_000; // 1 USDC: techo anti-typo (nunca drena de más)

export class EscrowSettlement {
  private submitter: ChainSubmitter;
  private cfg: EscrowConfig;
  private journal?: SettleJournal;
  private onPending?: (p: PendingSettle) => void;

  constructor(submitter: ChainSubmitter, cfg: EscrowConfig, journal?: SettleJournal, onPending?: (p: PendingSettle) => void) {
    this.submitter = submitter;
    this.cfg = cfg;
    this.journal = journal;
    this.onPending = onPending;
    if (!Number.isInteger(cfg.payout) || cfg.payout <= 0 || cfg.payout > PAYOUT_MAX) {
      throw new Error(`payout inválido: ${cfg.payout}`);
    }
  }

  // S22/S23: el release exige sha256 del resultado + firma ed25519 del forge.
  // S41/S42 (contrato v4): fund_job liga el job al worker; release verifica la
  // firma contra la pubkey que ESE worker registró — y el worker puede
  // self-claim si el operador no liquida.
  // S34: workerAddr por-job — en la red remota cada forge cobra en SU pubkey
  // (= su identidad). Default = cfg.worker (embedded/legacy).
  // S44: el fund queda journalado ANTES del release — un crash acá deja
  // referencia durable para el sweep de boot (I3: nada huérfano).
  async settleJob(
    resultHash: Buffer,
    forgeSig: Buffer,
    workerAddr?: string,
    stats?: { genTokens?: number },
  ): Promise<SettleReceipt> {
    if (resultHash.length !== 32) {
      throw new Error(`result_hash debe ser 32 bytes, vino ${resultHash.length}`);
    }
    if (forgeSig.length !== 64) {
      throw new Error(`forge_sig debe ser 64 bytes, vino ${forgeSig.length}`);
    }
    const { contractId, operator } = this.cfg;
    const worker = workerAddr ?? this.cfg.worker;
    const payout = payoutFor(stats, { base: this.cfg.payout, perToken: this.cfg.perToken ?? 0 });
    const funded = await this.submitter.invoke(contractId, "fund_job", [
      new Address(operator).toScVal(),
      nativeToScVal(payout, { type: "i128" }),
      new Address(worker).toScVal(),
    ]);
    const jobId = Number(scValToNative(funded.retval as xdr.ScVal));
    await this.journal
      ?.record({
        jobId,
        worker,
        resultHash: resultHash.toString("hex"),
        forgeSig: forgeSig.toString("hex"),
        fundTx: funded.txHash,
        createdAt: Date.now(),
      })
      .catch((e) => console.warn(`settle journal record falló (job ${jobId}):`, e));
    try {
      const released = await this.submitter.invoke(contractId, "release", [
        new Address(operator).toScVal(),
        nativeToScVal(jobId, { type: "u64" }),
        nativeToScVal(resultHash), // BytesN<32> on-chain
        nativeToScVal(forgeSig), // BytesN<64> — proof L0
      ]);
      await this.journal?.markReleased(jobId, released.txHash).catch(() => {});
      return { jobId, fundTx: funded.txHash, releaseTx: released.txHash };
    } catch (e) {
      // Funded pero no released → queda pending: el sweep de boot lo retoma
      // y onPending notifica al forge (self-claim on-chain sin el operador).
      console.warn(`release falló post-fund (job ${jobId}, queda en journal):`, e);
      try {
        this.onPending?.({
          jobId,
          worker,
          resultHash: resultHash.toString("hex"),
          forgeSig: forgeSig.toString("hex"),
          fundTx: funded.txHash,
          createdAt: Date.now(),
        });
      } catch {}
      throw e;
    }
  }
}

// Submit real: simula→firma→envía→espera SUCCESS. Secret jamás sale de acá.
// S43: invoke corre serializado — dos txs concurrentes de la misma cuenta
// compiten por sequence number y la segunda revienta. La queue lo evita.
export class RpcSubmitter implements ChainSubmitter {
  private server: rpc.Server;
  private keypair: Keypair;
  private queue = new SerialQueue();

  constructor(rpcUrl: string, secret: string) {
    this.server = new rpc.Server(rpcUrl);
    this.keypair = Keypair.fromSecret(secret);
  }

  invoke(
    contractId: string,
    fn: string,
    args: xdr.ScVal[],
  ): Promise<{ txHash: string; retval?: xdr.ScVal }> {
    return this.queue.run(() => this.doInvoke(contractId, fn, args));
  }

  private async doInvoke(
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
