// ADR-0008 — EvmDepositWatcher: convierte depósitos WeaverCredits (Monad)
// en créditos del CreditLedger. Equivalente al DepositWatcher de Horizon.
//
// Convención `account`: el accountId viaja como UTF-8 en el bytes32 del
// evento (los "acct_…" son ≤31 chars → entran directo, reversibles on-chain
// sin lookup por hash). El payer queda en el log para observabilidad.
//
// Pollea eth_getLogs desde el último bloque procesado. Dedup por
// `dep:<txHash>:<logIndex>` como ref del topup — replay de página, re-poll
// o restart jamás acreditan dos veces (el ledger ya es idempotente por ref).
import { keccak256, stringToHex, hexToString, type Address, type Hex } from "viem";
import type { MemoResolver } from "./deposit.ts";
import type { CreditLedger } from "./ledger.ts";

// topic0 del evento Deposited(bytes32,address,uint256)
export const DEPOSITED_TOPIC = keccak256(stringToHex("Deposited(bytes32,address,uint256)"));

// accountId "acct_…" → bytes32 para deposit() (right-pad con ceros).
export function accountToBytes32(accountId: string): Hex {
  const hex = stringToHex(accountId);
  if (hex.length > 64 + 2) throw new Error(`accountId >31 bytes: ${accountId}`);
  return (hex + "0".repeat(64 - (hex.length - 2))) as Hex;
}

// bytes32 → accountId (null si no decodifica a utf8 con prefijo acct_).
export function bytes32ToAccount(b: string): string | null {
  try {
    const s = hexToString((b.startsWith("0x") ? b : `0x${b}`) as Hex).replace(/\0/g, "");
    return s.startsWith("acct_") ? s : null;
  } catch {
    return null;
  }
}

export type EvmLog = {
  topics: string[];
  data: string;
  transactionHash?: string;
  blockNumber?: string | bigint;
  logIndex?: number | string;
  removed?: boolean; // log huérfano por reorg — jamás acreditarlo
};

// Seam de transporte — en prod: publicClient.getLogs de viem; en tests: fake.
export type EvmLogFetcher = (args: {
  address: Address;
  topics: string[];
  fromBlock: bigint;
}) => Promise<EvmLog[]>;

export type EvmWatcherConfig = {
  credits: Address; // contrato WeaverCredits deployado
  store: MemoResolver;
  ledger: CreditLedger;
  fetcher: EvmLogFetcher;
  pollMs?: number;
  fromBlock?: bigint; // arranque (default 0 — el dedup absorbe el rescan)
  onEvent?: (msg: string) => void;
};

export class EvmDepositWatcher {
  private readonly cfg: EvmWatcherConfig;
  private readonly log: (m: string) => void;
  private cursor: bigint;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(cfg: EvmWatcherConfig) {
    this.cfg = cfg;
    this.cursor = cfg.fromBlock ?? 0n;
    this.log = cfg.onEvent ?? ((m) => console.warn(`evm-deposit-watcher: ${m}`));
  }

  /** Un ciclo de poll. Errores RPC se loguean y no cortan el loop. */
  async pollOnce(): Promise<void> {
    let logs: EvmLog[];
    try {
      logs = await this.cfg.fetcher({
        address: this.cfg.credits,
        topics: [DEPOSITED_TOPIC],
        fromBlock: this.cursor,
      });
    } catch (e) {
      this.log(`poll falló: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    let max = this.cursor;
    for (const l of logs) {
      if (l.topics[0] !== DEPOSITED_TOPIC) continue;
      if (l.removed === true) continue; // reorg: el log se fue, no se acredita
      const bn = typeof l.blockNumber === "string" ? BigInt(l.blockNumber) : l.blockNumber;
      if (bn !== undefined && bn < this.cursor) continue; // ya procesado
      await this.apply(l);
      if (bn !== undefined && bn > max) max = bn;
    }
    this.cursor = max;
  }

  private async apply(l: EvmLog): Promise<void> {
    const { store, ledger } = this.cfg;
    const accountId = l.topics[1] ? bytes32ToAccount(l.topics[1]) : null;
    const ref = `dep:${l.transactionHash ?? "unknown"}:${l.logIndex ?? 0}`;
    if (!accountId) {
      this.log(`log ${ref}: account bytes32 no decodifica a acct_… — ignorado`);
      return;
    }
    const amount = BigInt(l.data);
    if (amount <= 0n) return;
    const account = await store.get(accountId);
    if (!account) {
      this.log(`log ${ref}: accountId "${accountId}" sin cuenta — fondos sin acreditar`);
      return;
    }
    const applied = await ledger.credit(account.id, amount, ref);
    if (applied) this.log(`acreditado ${amount} base units → ${account.id} (${ref})`);
  }

  /** Mueve el cursor — boot en head cuando el operador no quiere rescan. */
  seek(block: bigint): void {
    this.cursor = block;
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
