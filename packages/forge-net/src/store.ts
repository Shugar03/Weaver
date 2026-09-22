// S30 — ForgeStore: identidades registradas (pubkey, attested, lastSeen).
// El estado VIVO (capacidad, inFlight) es in-memory en el registry — un forge
// solo existe mientras heartbeatea; el store persiste la identidad entre boots.
import { forges as forgesTable } from "@weaver/db";
import type { Db } from "@weaver/db";
import { eq, sql } from "drizzle-orm";

export type ForgeIdentity = {
  pubkey: string;
  displayName?: string;
  attested: boolean;
  // S46: strikes de audit (mismatch de modelo). Persistidos — un restart
  // del gateway no es una segunda chance para un forge que mintió.
  strikes: number;
  createdAt: number;
  lastSeenAt: number;
};

export interface ForgeStore {
  upsert(f: { pubkey: string; displayName?: string }): Promise<void>;
  get(pubkey: string): Promise<ForgeIdentity | null>;
  setAttested(pubkey: string, attested: boolean): Promise<void>;
  touch(pubkey: string, at: number): Promise<void>;
  // S46: strikes persistentes — devuelve el nuevo total.
  addStrike(pubkey: string): Promise<number>;
  resetStrikes(pubkey: string): Promise<void>;
}

export class InMemoryForgeStore implements ForgeStore {
  private readonly rows = new Map<string, ForgeIdentity>();
  async upsert(f: { pubkey: string; displayName?: string }): Promise<void> {
    const prev = this.rows.get(f.pubkey);
    this.rows.set(f.pubkey, {
      pubkey: f.pubkey,
      displayName: f.displayName ?? prev?.displayName,
      attested: prev?.attested ?? false,
      strikes: prev?.strikes ?? 0,
      createdAt: prev?.createdAt ?? Date.now(),
      lastSeenAt: Date.now(),
    });
  }
  async get(pubkey: string): Promise<ForgeIdentity | null> {
    return this.rows.get(pubkey) ?? null;
  }
  async setAttested(pubkey: string, attested: boolean): Promise<void> {
    const r = this.rows.get(pubkey);
    if (r) this.rows.set(pubkey, { ...r, attested });
  }
  async touch(pubkey: string, at: number): Promise<void> {
    const r = this.rows.get(pubkey);
    if (r) this.rows.set(pubkey, { ...r, lastSeenAt: at });
  }
  async addStrike(pubkey: string): Promise<number> {
    const r = this.rows.get(pubkey);
    const n = (r?.strikes ?? 0) + 1;
    if (r) this.rows.set(pubkey, { ...r, strikes: n });
    return n;
  }
  async resetStrikes(pubkey: string): Promise<void> {
    const r = this.rows.get(pubkey);
    if (r) this.rows.set(pubkey, { ...r, strikes: 0 });
  }
}

export class PostgresForgeStore implements ForgeStore {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }
  async upsert(f: { pubkey: string; displayName?: string }): Promise<void> {
    await this.db
      .insert(forgesTable)
      .values({ pubkey: f.pubkey, displayName: f.displayName, lastSeenAt: new Date() })
      .onConflictDoUpdate({
        target: forgesTable.pubkey,
        set: { lastSeenAt: new Date(), ...(f.displayName ? { displayName: f.displayName } : {}) },
      });
  }
  async get(pubkey: string): Promise<ForgeIdentity | null> {
    const rows = await this.db.select().from(forgesTable).where(eq(forgesTable.pubkey, pubkey)).limit(1);
    const r = rows[0];
    return r
      ? { pubkey: r.pubkey, displayName: r.displayName ?? undefined, attested: r.attested, strikes: r.strikes, createdAt: r.createdAt.getTime(), lastSeenAt: r.lastSeenAt.getTime() }
      : null;
  }
  async setAttested(pubkey: string, attested: boolean): Promise<void> {
    await this.db.update(forgesTable).set({ attested }).where(eq(forgesTable.pubkey, pubkey));
  }
  async touch(pubkey: string, at: number): Promise<void> {
    await this.db.update(forgesTable).set({ lastSeenAt: new Date(at) }).where(eq(forgesTable.pubkey, pubkey));
  }
  async addStrike(pubkey: string): Promise<number> {
    const rows = await this.db
      .update(forgesTable)
      .set({ strikes: sql`${forgesTable.strikes} + 1` })
      .where(eq(forgesTable.pubkey, pubkey))
      .returning({ strikes: forgesTable.strikes });
    return rows[0]?.strikes ?? 1;
  }
  async resetStrikes(pubkey: string): Promise<void> {
    await this.db.update(forgesTable).set({ strikes: 0 }).where(eq(forgesTable.pubkey, pubkey));
  }
}
