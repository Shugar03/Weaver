// Module Settlement — SettleDispatcher: en una fleet mixta la vía de settle
// la decide la identidad del forge que sirvió (formato del worker), no un
// env global. Un worker Stellar cobra en Stellar, un worker EVM en Monad.
// La vía no configurada → error explícito: el job se sirvió pero no se pagó
// — visible, jamás un cast a Address que revienta dentro de viem.
import { isEvmAddr } from "./verify.ts";
import type { SettleReceipt, SplitSettleReceipt, StagePayout } from "./escrow.ts";

export interface SettleVia {
  settleJob(resultHash: Buffer, forgeSig: Buffer, worker?: string, stats?: { genTokens?: number }): Promise<SettleReceipt>;
  // B6: split por stage — solo vías cuya prueba de firma verifica las
  // stageSigs ed25519 on-chain lo implementan (Stellar sí; el ecrecover EVM
  // no verifica ed25519 → el coordinator EVM cobra entero, declarado).
  settleJobSplit?(
    resultHash: Buffer,
    coordSig: Buffer,
    coordWorker: string | undefined,
    stats: { genTokens?: number } | undefined,
    stages: StagePayout[],
  ): Promise<SplitSettleReceipt>;
}

export class SettleDispatcher implements SettleVia {
  private readonly evm?: SettleVia;
  private readonly stellar?: SettleVia;
  private readonly defaultChain: "evm" | "stellar";

  constructor(opts: { evm?: SettleVia; stellar?: SettleVia; defaultChain?: "evm" | "stellar" }) {
    if (!opts.evm && !opts.stellar) throw new Error("SettleDispatcher sin vías configuradas");
    this.evm = opts.evm;
    this.stellar = opts.stellar;
    this.defaultChain = opts.defaultChain ?? (opts.evm ? "evm" : "stellar");
  }

  async settleJob(resultHash: Buffer, forgeSig: Buffer, worker?: string, stats?: { genTokens?: number }) {
    const via = this.viaFor(worker); // sync-throw → rechazo (misma superficie async)
    return via.settleJob(resultHash, forgeSig, worker, stats);
  }

  // B6: rutea el split por la vía del coordinator. Si esa vía no implementa
  // multi-escrow (EVM), cae al single-settle honesto — el coordinator cobra
  // el total y los stages quedan declarados en el receipt sin pago on-chain.
  async settleJobSplit(
    resultHash: Buffer,
    coordSig: Buffer,
    worker: string | undefined,
    stats: { genTokens?: number } | undefined,
    stages: StagePayout[],
  ): Promise<SplitSettleReceipt> {
    const via = this.viaFor(worker);
    if (!via.settleJobSplit) {
      console.warn(`split settle: la vía de ${worker} no soporta multi-escrow — settle single al coordinator`);
      const r = await via.settleJob(resultHash, coordSig, worker, stats);
      // Sin monto: la vía nunca computó el split — declarar shares sería mentira.
      return { ...r, splits: stages.map((s) => ({ worker: s.worker, error: "vía sin multi-escrow" })) };
    }
    return via.settleJobSplit(resultHash, coordSig, worker, stats, stages);
  }

  private viaFor(worker: string | undefined): SettleVia {
    if (worker === undefined) {
      const via = this.defaultChain === "evm" ? this.evm : this.stellar;
      if (!via) throw new Error(`no-settler-for-format: default ${this.defaultChain} sin configurar`);
      return via;
    }
    if (isEvmAddr(worker)) {
      if (!this.evm) throw new Error(`no-settler-for-format: worker EVM ${worker} sin vía evm configurada`);
      return this.evm;
    }
    // Stellar = G… (strkey ed25519). Cualquier otro formato → explícito.
    if (/^G[A-Z2-7]{55}$/.test(worker)) {
      if (!this.stellar) throw new Error(`no-settler-for-format: worker Stellar ${worker} sin vía stellar configurada`);
      return this.stellar;
    }
    throw new Error(`worker-format desconocido: ${worker}`);
  }
}
