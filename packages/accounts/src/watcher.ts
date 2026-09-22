// S47 (ADR-0007) — DepositWatcher: convierte payments clásicos USDC en
// créditos. Pollea Horizon `/accounts/{deposit}/payments?join=transactions`
// (los memos solo existen en txs clásicas — un SAC invoke no los lleva).
// Dedup por op.id como ref del topup → replay de página, re-poll o restart
// jamás acreditan dos veces (el ledger ya es idempotente por ref).
// Cursor in-memory: el boot re-escanea la última página — el dedup absorbe
// lo ya aplicado, así que una caída no pierde depósitos recientes.
import { accountByMemo, type MemoResolver } from "./deposit.ts";
import type { CreditLedger } from "./ledger.ts";

export type HorizonOp = {
  id: string;
  paging_token?: string;
  type: string;
  to?: string;
  asset_code?: string;
  asset_issuer?: string;
  amount?: string;
  transaction?: { hash?: string; memo_type?: string; memo?: string };
};
export type HorizonPage = { _embedded?: { records?: HorizonOp[] } };
export type HorizonFetcher = (url: string) => Promise<HorizonPage>;

export type WatcherConfig = {
  horizonUrl: string;
  depositAddress: string;
  assetCode: string;
  assetIssuer: string;
  store: MemoResolver;
  ledger: CreditLedger;
  fetcher?: HorizonFetcher;
  pollMs?: number;
  onEvent?: (msg: string) => void;
};

// "2.5000000" USDC → stroops bigint, sin floats (precisión exacta).
export function amountToStroops(amount: string): bigint | null {
  const m = /^(\d+)(?:\.(\d{1,7}))?$/.exec(amount.trim());
  if (!m) return null;
  return BigInt(m[1]!) * 10_000_000n + BigInt((m[2] ?? "").padEnd(7, "0") || "0");
}

const defaultFetch: HorizonFetcher = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`horizon http ${r.status}`);
  return (await r.json()) as HorizonPage;
};

export class DepositWatcher {
  private readonly cfg: WatcherConfig;
  private readonly fetcher: HorizonFetcher;
  private readonly log: (m: string) => void;
  private cursor: string | null = null; // último op.id procesado (monótono)
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(cfg: WatcherConfig) {
    this.cfg = cfg;
    this.fetcher = cfg.fetcher ?? defaultFetch;
    this.log = cfg.onEvent ?? ((m) => console.warn(`deposit-watcher: ${m}`));
  }

  private url(): string {
    const { horizonUrl, depositAddress } = this.cfg;
    return `${horizonUrl.replace(/\/$/, "")}/accounts/${depositAddress}/payments?join=transactions&order=desc&limit=50`;
  }

  /** Un ciclo de poll. Errores de red/parseo se loguean y no cortan el loop. */
  async pollOnce(): Promise<void> {
    let page: HorizonPage;
    try {
      page = await this.fetcher(this.url());
    } catch (e) {
      this.log(`poll falló: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    // desc → asc: acreditamos en orden de llegada real.
    const records = [...(page._embedded?.records ?? [])].reverse();
    for (const op of records) {
      const opId = op.paging_token ?? op.id;
      if (this.cursor !== null && BigInt(opId) <= BigInt(this.cursor)) continue;
      await this.apply(op);
      this.cursor = opId;
    }
  }

  private async apply(op: HorizonOp): Promise<void> {
    const { assetCode, assetIssuer, depositAddress, store, ledger } = this.cfg;
    if (op.type !== "payment" || op.to !== depositAddress) return;
    if (op.asset_code !== assetCode || op.asset_issuer !== assetIssuer) return;
    const memo = op.transaction?.memo;
    if (op.transaction?.memo_type !== "text" || !memo) {
      this.log(`op ${op.id}: payment sin memo text — ignorado`);
      return;
    }
    const stroops = amountToStroops(op.amount ?? "");
    if (!stroops || stroops <= 0n) {
      this.log(`op ${op.id}: amount inválido "${op.amount}" — ignorado`);
      return;
    }
    const account = await accountByMemo(store, memo);
    if (!account) {
      this.log(`op ${op.id}: memo "${memo}" sin cuenta — fondos sin acreditar`);
      return;
    }
    const applied = await ledger.credit(account.id, stroops, `dep:${op.id}`);
    if (applied) this.log(`acreditado ${op.amount} ${assetCode} → ${account.id} (op ${op.id})`);
  }

  start(): void {
    if (this.timer) return;
    void this.pollOnce();
    this.timer = setInterval(() => void this.pollOnce(), this.cfg.pollMs ?? 15_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
