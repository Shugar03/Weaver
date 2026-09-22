// S47 (ADR-0007) — CreditLedger: plata del usuario en stroops (7 dec USDC).
// Append-only, dos kinds:
//   topup — depósito USDC on-chain; ref = tx hash (dedup: replay no duplica)
//   debit — consumo post-serve medido; ref = jobId (idempotente por job)
// A2: nada inventa plata — credit exige ref, debit exige costo calculado
// afuera sobre usage real. El balance puede quedar negativo si el débito
// post-stream supera lo estimado: queda visible, jamás se trunca el stream.
import { creditEvents, type Db } from "@weaver/db";
import { eq, sql } from "drizzle-orm";

export type CreditEvent = {
  id: number;
  kind: "topup" | "debit";
  amount: bigint; // stroops — topup positivo, debit se guarda positivo y resta en balance
  ref: string;
  createdAt: number;
};

export interface CreditLedger {
  /** Acredita stroops; false si el ref ya fue aplicado (dedup idempotente). */
  credit(accountId: string, stroops: bigint, ref: string): Promise<boolean>;
  /** Debita stroops; false si el ref ya fue aplicado. */
  debit(accountId: string, stroops: bigint, ref: string): Promise<boolean>;
  /** Balance = Σ topup − Σ debit (puede ser negativo — visible, no oculto). */
  balance(accountId: string): Promise<bigint>;
  history(accountId: string, limit?: number): Promise<CreditEvent[]>;
}

export class InMemoryCreditLedger implements CreditLedger {
  private readonly rows: (CreditEvent & { accountId: string })[] = [];
  private readonly seen = new Set<string>();
  private seq = 0;

  private apply(accountId: string, kind: CreditEvent["kind"], stroops: bigint, ref: string): boolean {
    const key = `${kind}:${ref}`;
    if (stroops <= 0n || this.seen.has(key)) return false;
    this.seen.add(key);
    this.rows.push({ id: ++this.seq, accountId, kind, amount: stroops, ref, createdAt: Date.now() });
    return true;
  }
  credit(accountId: string, stroops: bigint, ref: string): Promise<boolean> {
    return Promise.resolve(this.apply(accountId, "topup", stroops, ref));
  }
  debit(accountId: string, stroops: bigint, ref: string): Promise<boolean> {
    return Promise.resolve(this.apply(accountId, "debit", stroops, ref));
  }
  async balance(accountId: string): Promise<bigint> {
    return this.rows.reduce((acc, r) => (r.accountId !== accountId ? acc : r.kind === "topup" ? acc + r.amount : acc - r.amount), 0n);
  }
  async history(accountId: string, limit = 50): Promise<CreditEvent[]> {
    return this.rows
      .filter((r) => r.accountId === accountId)
      .slice(-limit)
      .map(({ accountId: _a, ...e }) => e);
  }
}

export class PostgresCreditLedger implements CreditLedger {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  private async apply(accountId: string, kind: string, stroops: bigint, ref: string): Promise<boolean> {
    if (stroops <= 0n) return false;
    const r = await this.db
      .insert(creditEvents)
      .values({ accountId, kind, amount: stroops, ref })
      .onConflictDoNothing({ target: [creditEvents.kind, creditEvents.ref] })
      .returning({ id: creditEvents.id });
    return r.length > 0;
  }
  credit(accountId: string, stroops: bigint, ref: string): Promise<boolean> {
    return this.apply(accountId, "topup", stroops, ref);
  }
  debit(accountId: string, stroops: bigint, ref: string): Promise<boolean> {
    return this.apply(accountId, "debit", stroops, ref);
  }
  async balance(accountId: string): Promise<bigint> {
    const rows = await this.db
      .select({ v: sql<bigint>`coalesce(sum(case when ${creditEvents.kind} = 'topup' then ${creditEvents.amount} else -${creditEvents.amount} end), 0)` })
      .from(creditEvents)
      .where(eq(creditEvents.accountId, accountId));
    return rows[0]?.v ?? 0n;
  }
  async history(accountId: string, limit = 50): Promise<CreditEvent[]> {
    const rows = await this.db
      .select()
      .from(creditEvents)
      .where(eq(creditEvents.accountId, accountId))
      .orderBy(sql`${creditEvents.id} desc`)
      .limit(limit);
    return rows.map((r) => ({ id: r.id, kind: r.kind as CreditEvent["kind"], amount: r.amount, ref: r.ref, createdAt: r.createdAt.getTime() }));
  }
}
