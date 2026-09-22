// S44 — SettleJournal (ADR-0006, I3): plata fondeada jamás queda huérfana.
// fund_job devuelve jobId; si el proceso muere antes del release, el journal
// es la ÚNICA referencia a ese escrow. Boot sweep: pending() → re-release
// (el proof sigue válido) o refund si el forge ya no es reclamable.
import { settleJobs } from "@weaver/db";
import type { Db } from "@weaver/db";
import { eq } from "drizzle-orm";

export type PendingSettle = {
  jobId: number;
  worker: string;
  resultHash: string; // hex
  forgeSig: string; // hex
  fundTx: string;
  createdAt: number;
};

export interface SettleJournal {
  record(s: PendingSettle): Promise<void>;
  markReleased(jobId: number, releaseTx: string): Promise<void>;
  markFailed(jobId: number, reason: string): Promise<void>;
  pending(): Promise<PendingSettle[]>;
}

export class InMemorySettleJournal implements SettleJournal {
  private rows = new Map<number, PendingSettle & { state: string }>();

  async record(s: PendingSettle): Promise<void> {
    this.rows.set(s.jobId, { ...s, state: "funded" });
  }
  async markReleased(jobId: number): Promise<void> {
    const r = this.rows.get(jobId);
    if (r) r.state = "released";
  }
  async markFailed(jobId: number): Promise<void> {
    const r = this.rows.get(jobId);
    if (r) r.state = "failed";
  }
  async pending(): Promise<PendingSettle[]> {
    return [...this.rows.values()].filter((r) => r.state === "funded");
  }
}

// — Postgres — la tabla vive en @weaver/db (schema compartido, ADR-0002).
export class PostgresSettleJournal implements SettleJournal {
  private db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  async record(s: PendingSettle): Promise<void> {
    await this.db.insert(settleJobs).values({
      jobId: s.jobId,
      worker: s.worker,
      resultHash: s.resultHash,
      forgeSig: s.forgeSig,
      fundTx: s.fundTx,
      state: "funded",
    });
  }
  async markReleased(jobId: number, releaseTx: string): Promise<void> {
    await this.db.update(settleJobs).set({ state: "released", releaseTx }).where(eq(settleJobs.jobId, jobId));
  }
  async markFailed(jobId: number, reason: string): Promise<void> {
    await this.db.update(settleJobs).set({ state: "failed", failReason: reason }).where(eq(settleJobs.jobId, jobId));
  }
  async pending(): Promise<PendingSettle[]> {
    const rows = await this.db.select().from(settleJobs).where(eq(settleJobs.state, "funded"));
    return rows.map((r) => ({
      jobId: r.jobId,
      worker: r.worker,
      resultHash: r.resultHash,
      forgeSig: r.forgeSig,
      fundTx: r.fundTx,
      createdAt: r.createdAt.getTime(),
    }));
  }
}
