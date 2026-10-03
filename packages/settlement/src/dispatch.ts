// Module Settlement — SettleDispatcher: en una fleet mixta la vía de settle
// la decide la identidad del forge que sirvió (formato del worker), no un
// env global. Un worker Stellar cobra en Stellar, un worker EVM en Monad.
// La vía no configurada → error explícito: el job se sirvió pero no se pagó
// — visible, jamás un cast a Address que revienta dentro de viem.
import { isEvmAddr } from "./verify.ts";
import type { SettleReceipt } from "./escrow.ts";

export interface SettleVia {
  settleJob(resultHash: Buffer, forgeSig: Buffer, worker?: string, stats?: { genTokens?: number }): Promise<SettleReceipt>;
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
