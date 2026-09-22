// Module Telemetry — Postgres (ADR-0002). Misma Interface, queries con índice model+ts.
// p50 se calcula en SQL (percentile_cont); recent pagina por id DESC.
import { and, desc, eq, sql } from "drizzle-orm";
import { JOB_PRICE_USDC } from "@weaver/settlement";
import { type Db, performanceSamples } from "@weaver/db";
import { P50_WINDOW, type Sample, type Telemetry, type Usage } from "./ports.ts";

export class PostgresTelemetry implements Telemetry {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  async record(s: Sample): Promise<void> {
    await this.db.insert(performanceSamples).values({
      forgeId: s.forgeId,
      model: s.model,
      ttftMs: s.ttftMs,
      ok: s.ok,
      ts: s.ts,
      keyId: s.keyId ?? null,
      payerTx: s.settle?.payerTx ?? null,
      fundTx: s.settle?.fundTx ?? null,
      releaseTx: s.settle?.releaseTx ?? null,
      settleStatus: s.settle?.status ?? null,
    });
  }

  async p50(model: string, forgeId: string): Promise<number> {
    // S27: ventana — mediana sobre los últimos P50_WINDOW samples ok del forge
    // (subquery por ts desc), no all-time: un forge degradado debe reflejarse ya.
    const rows = await this.db
      .select({ v: sql<number>`percentile_cont(0.5) within group (order by ttft_ms)` })
      .from(
        sql`(
          select ttft_ms from performance_samples
          where model = ${model} and forge_id = ${forgeId} and ok
          order by ts desc limit ${P50_WINDOW}
        ) recent`,
      );
    return Math.round(rows[0]?.v ?? 0);
  }

  async recent(n: number): Promise<Sample[]> {
    const rows = await this.db
      .select()
      .from(performanceSamples)
      .orderBy(desc(performanceSamples.id))
      .limit(Math.min(50, Math.max(1, n)));
    return rows.map((r) => ({
      forgeId: r.forgeId,
      model: r.model,
      ttftMs: r.ttftMs,
      ok: r.ok,
      ts: r.ts,
      ...(r.keyId ? { keyId: r.keyId } : {}),
      ...(r.settleStatus
        ? {
            settle: {
              status: r.settleStatus as "pending" | "settled" | "failed",
              ...(r.payerTx ? { payerTx: r.payerTx } : {}),
              ...(r.fundTx ? { fundTx: r.fundTx } : {}),
              ...(r.releaseTx ? { releaseTx: r.releaseTx } : {}),
            },
          }
        : {}),
    }));
  }

  async usage(keyId?: string): Promise<Usage> {
    const where = keyId ? eq(performanceSamples.keyId, keyId) : undefined;
    const rows = await this.db
      .select({
        jobs: sql<number>`count(*)::int`,
        ok: sql<number>`count(*) filter (where ok)::int`,
      })
      .from(performanceSamples)
      .where(where);
    const jobs = rows[0]?.jobs ?? 0;
    const ok = rows[0]?.ok ?? 0;
    return {
      jobs,
      ok,
      okRate: jobs === 0 ? 0 : ok / jobs,
      spentUSDC: Math.round(ok * JOB_PRICE_USDC * 100) / 100,
    };
  }
}
