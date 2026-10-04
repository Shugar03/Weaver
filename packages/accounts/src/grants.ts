// spec 012 — DelegationGrants: delegaciones MetaMask ya canjeadas.
// El grant se persiste como JSON opaco — este paquete no conoce el shape de
// settlement/delegation; el gateway verifica firma+caveats ANTES de save.
// PK = delegationHash: dedup estructural (el topup usa ref dlg:<hash> — la
// fila también lo defiende si el ledger fuese de otro backend).
import { delegations, type Db } from "@weaver/db";
import { eq } from "drizzle-orm";

export type DelegationGrant = {
  hash: string;
  accountId: string;
  delegator: string;
  delegate: string;
  delegationJson: string;
  amountStroops: bigint;
  expiresAt: number | null;
  createdAt: number;
};

export interface DelegationGrants {
  /** Inserta el grant; false si el hash ya existía (replay de redeem). */
  save(grant: DelegationGrant): Promise<boolean>;
  byHash(hash: string): Promise<DelegationGrant | null>;
  byAccount(accountId: string): Promise<DelegationGrant[]>;
}

export class InMemoryDelegationGrants implements DelegationGrants {
  private readonly rows = new Map<string, DelegationGrant>();

  save(grant: DelegationGrant): Promise<boolean> {
    if (this.rows.has(grant.hash)) return Promise.resolve(false);
    this.rows.set(grant.hash, grant);
    return Promise.resolve(true);
  }
  byHash(hash: string): Promise<DelegationGrant | null> {
    return Promise.resolve(this.rows.get(hash) ?? null);
  }
  byAccount(accountId: string): Promise<DelegationGrant[]> {
    return Promise.resolve([...this.rows.values()].filter((g) => g.accountId === accountId));
  }
}

export class PostgresDelegationGrants implements DelegationGrants {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  async save(grant: DelegationGrant): Promise<boolean> {
    const r = await this.db
      .insert(delegations)
      .values({
        hash: grant.hash,
        accountId: grant.accountId,
        delegator: grant.delegator,
        delegate: grant.delegate,
        delegationJson: grant.delegationJson,
        amountStroops: grant.amountStroops,
        expiresAt: grant.expiresAt === null ? null : new Date(grant.expiresAt),
      })
      .onConflictDoNothing({ target: delegations.hash })
      .returning({ hash: delegations.hash });
    return r.length > 0;
  }

  private static toGrant(r: typeof delegations.$inferSelect): DelegationGrant {
    return {
      hash: r.hash,
      accountId: r.accountId,
      delegator: r.delegator,
      delegate: r.delegate,
      delegationJson: r.delegationJson,
      amountStroops: r.amountStroops,
      expiresAt: r.expiresAt?.getTime() ?? null,
      createdAt: r.createdAt.getTime(),
    };
  }

  async byHash(hash: string): Promise<DelegationGrant | null> {
    const rows = await this.db.select().from(delegations).where(eq(delegations.hash, hash));
    return rows[0] ? PostgresDelegationGrants.toGrant(rows[0]) : null;
  }

  async byAccount(accountId: string): Promise<DelegationGrant[]> {
    const rows = await this.db.select().from(delegations).where(eq(delegations.accountId, accountId));
    return rows.map(PostgresDelegationGrants.toGrant);
  }
}
