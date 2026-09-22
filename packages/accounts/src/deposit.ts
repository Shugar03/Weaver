// S47 (ADR-0007) — memos de depósito. El usuario fondea con un payment
// CLÁSICO USDC (los memos solo existen en txs clásicas — un SAC invoke no
// los lleva). MEMO_TEXT ≤28 chars: `acct_<ts36>_<6b64>` ≈ 20 chars entra.
// Si la cuenta tiene wallet linkeada, el memo puede ser la pubkey (G... =
// 56 chars NO entra en MEMO_TEXT — entonces el memo es SIEMPRE el id).
// Resolver inverso: memo → cuenta. El watcher lo usa para acreditar.
import type { Account } from "./store.ts";

export function depositMemoFor(account: Account): string {
  return account.id; // acct_... ≤28 chars, único, inmutable
}

/** Seam que el DepositWatcher usa: memo → cuenta (id directo o wallet). */
export interface MemoResolver {
  get(id: string): Promise<Account | null>;
  byWallet(pubkey: string): Promise<Account | null>;
}

export async function accountByMemo(store: MemoResolver, memo: string): Promise<Account | null> {
  const m = memo.trim();
  if (!m) return null;
  if (m.startsWith("acct_")) return store.get(m);
  if (m.startsWith("G") && m.length === 56) return store.byWallet(m);
  return null;
}
