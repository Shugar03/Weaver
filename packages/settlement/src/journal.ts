// S44 — SettleJournal (ADR-0006, I3): plata fondeada jamás queda huérfana.
// fund_job devuelve jobId; si el proceso muere antes del release, el journal
// es la ÚNICA referencia a ese escrow. Boot sweep: pending() → re-release
// (el proof sigue válido) o refund si el forge ya no es reclamable.
import { scanCursors, settleIntents, settleJobs } from "@weaver/db";
import type { Db } from "@weaver/db";
import { and, eq, isNull } from "drizzle-orm";

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

// — Intent-first (S50, EVM) —
// El proof se persiste ANTES de fundJob bajo un jobKey único por llamada
// (no derivable de la sig — firmas deterministas de outputs idénticos
// colisionarían la PK entre requests distintos).
// Invariante fail-closed: si recordIntent falla, settleJob aborta antes de
// fondear → no puede existir un escrow on-chain sin proof journalizado.
// attachJob liga el jobId cuando Funded mina; un crash entre fund y attach
// deja un 'intent' + un job Funded on-chain → reconcileEvmOrphans los
// empareja por worker y cierra el release.
export type SettleIntent = {
  jobKey: string;
  worker: string;
  resultHash: string;
  forgeSig: string;
  jobId?: number;
  fundTx?: string;
  createdAt: number;
};

export interface IntentJournal extends SettleJournal {
  recordIntent(i: Omit<SettleIntent, "jobId" | "fundTx">): Promise<void>;
  attachJob(jobKey: string, jobId: number, fundTx: string): Promise<void>;
  // Cierra un intent huérfano (fundJob nunca minó): failed + razón — queda
  // audit trail y deja de advertir en cada ciclo del reconciler.
  discardIntent(jobKey: string, reason: string): Promise<void>;
  intentsWithoutJob(): Promise<SettleIntent[]>;
  knownJobIds(): Promise<number[]>;
}

export class InMemoryIntentJournal implements IntentJournal {
  private rows = new Map<string, SettleIntent & { state: string }>();

  async recordIntent(i: Omit<SettleIntent, "jobId" | "fundTx">): Promise<void> {
    // PK semantics idénticas a Postgres: jobKey duplicado es bug del caller
    // (keys únicos por llamada) — fail loud, nunca clobber silencioso.
    if (this.rows.has(i.jobKey)) throw new Error(`intent duplicado: ${i.jobKey}`);
    this.rows.set(i.jobKey, { ...i, state: "intent" });
  }
  async attachJob(jobKey: string, jobId: number, fundTx: string): Promise<void> {
    const r = this.rows.get(jobKey);
    if (r && r.state === "intent") Object.assign(r, { jobId, fundTx, state: "funded" });
  }
  async record(s: PendingSettle): Promise<void> {
    // Compat SettleJournal: registro directo funded (paths que no usan intent).
    this.rows.set(`job:${s.jobId}`, { ...s, jobKey: `job:${s.jobId}`, state: "funded" });
  }
  async markReleased(jobId: number): Promise<void> {
    const r = this.byJobId(jobId);
    if (r) r.state = "released";
  }
  async markFailed(jobId: number): Promise<void> {
    const r = this.byJobId(jobId);
    if (r) r.state = "failed";
  }
  async pending(): Promise<PendingSettle[]> {
    return [...this.rows.values()]
      .filter((r) => r.state === "funded" && r.jobId !== undefined)
      .map((r) => ({
        jobId: r.jobId!,
        worker: r.worker,
        resultHash: r.resultHash,
        forgeSig: r.forgeSig,
        fundTx: r.fundTx!,
        createdAt: r.createdAt,
      }));
  }
  async discardIntent(jobKey: string, reason: string): Promise<void> {
    const r = this.rows.get(jobKey);
    if (r && r.state === "intent") r.state = `failed:${reason.slice(0, 40)}`;
  }
  async intentsWithoutJob(): Promise<SettleIntent[]> {
    return [...this.rows.values()].filter((r) => r.state === "intent").map(({ state: _, ...i }) => i);
  }
  async knownJobIds(): Promise<number[]> {
    return [...this.rows.values()].flatMap((r) => (r.jobId !== undefined ? [r.jobId] : []));
  }
  private byJobId(jobId: number) {
    return [...this.rows.values()].find((r) => r.jobId === jobId);
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

// S52: cursor durable de scan — PostgresScanCursor. Una fila por watcher;
// upsert por nombre. Comparte la conexión del journal (misma DB del gateway).
export class PostgresScanCursor {
  private db: Db;
  private name: string;
  constructor(db: Db, name: string) {
    this.db = db;
    this.name = name;
  }
  async load(): Promise<bigint | null> {
    const rows = await this.db.select({ head: scanCursors.head }).from(scanCursors).where(eq(scanCursors.name, this.name));
    return rows.length === 0 ? null : BigInt(rows[0].head);
  }
  async save(head: bigint): Promise<void> {
    await this.db
      .insert(scanCursors)
      .values({ name: this.name, head: head.toString() })
      .onConflictDoUpdate({ target: scanCursors.name, set: { head: head.toString(), updatedAt: new Date() } });
  }
}

// PostgresIntentJournal: misma semántica intent-first sobre settle_intents.
export class PostgresIntentJournal implements IntentJournal {
  private db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  async recordIntent(i: Omit<SettleIntent, "jobId" | "fundTx">): Promise<void> {
    await this.db.insert(settleIntents).values({
      jobKey: i.jobKey,
      worker: i.worker,
      resultHash: i.resultHash,
      forgeSig: i.forgeSig,
      state: "intent",
      createdAt: new Date(i.createdAt),
    });
  }
  async attachJob(jobKey: string, jobId: number, fundTx: string): Promise<void> {
    await this.db
      .update(settleIntents)
      .set({ jobId, fundTx, state: "funded" })
      .where(eq(settleIntents.jobKey, jobKey));
  }
  async record(s: PendingSettle): Promise<void> {
    await this.db.insert(settleIntents).values({
      jobKey: `job:${s.jobId}`,
      jobId: s.jobId,
      worker: s.worker,
      resultHash: s.resultHash,
      forgeSig: s.forgeSig,
      fundTx: s.fundTx,
      state: "funded",
      createdAt: new Date(s.createdAt),
    });
  }
  async markReleased(jobId: number, releaseTx: string): Promise<void> {
    await this.db.update(settleIntents).set({ state: "released", releaseTx }).where(eq(settleIntents.jobId, jobId));
  }
  async markFailed(jobId: number, reason: string): Promise<void> {
    await this.db.update(settleIntents).set({ state: "failed", failReason: reason }).where(eq(settleIntents.jobId, jobId));
  }
  async pending(): Promise<PendingSettle[]> {
    const rows = await this.db.select().from(settleIntents).where(eq(settleIntents.state, "funded"));
    return rows.flatMap((r) =>
      r.jobId === null
        ? []
        : [{
            jobId: r.jobId,
            worker: r.worker,
            resultHash: r.resultHash,
            forgeSig: r.forgeSig,
            fundTx: r.fundTx ?? "",
            createdAt: r.createdAt.getTime(),
          }],
    );
  }
  async discardIntent(jobKey: string, reason: string): Promise<void> {
    await this.db
      .update(settleIntents)
      .set({ state: "failed", failReason: reason })
      .where(and(eq(settleIntents.jobKey, jobKey), eq(settleIntents.state, "intent")));
  }
  async intentsWithoutJob(): Promise<SettleIntent[]> {
    const rows = await this.db
      .select()
      .from(settleIntents)
      .where(and(eq(settleIntents.state, "intent"), isNull(settleIntents.jobId)));
    return rows.map((r) => ({
      jobKey: r.jobKey,
      worker: r.worker,
      resultHash: r.resultHash,
      forgeSig: r.forgeSig,
      createdAt: r.createdAt.getTime(),
    }));
  }
  async knownJobIds(): Promise<number[]> {
    const rows = await this.db.select({ jobId: settleIntents.jobId }).from(settleIntents);
    return rows.flatMap((r) => (r.jobId === null ? [] : [r.jobId]));
  }
}
