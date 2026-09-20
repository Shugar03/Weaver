// Module Telemetry — Postgres (ADR-0002). Misma Interface, queries con índice model+ts.
// p50 se calcula en SQL (percentile_cont); recent pagina por id DESC.
import { and, desc, eq, sql } from "drizzle-orm";
import { type Db, performanceSamples } from "@weaver/db";
import type { Sample, Telemetry } from "./ports.ts";

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
    });
  }

  async p50(model: string): Promise<number> {
    const rows = await this.db
      .select({ v: sql<number>`percentile_cont(0.5) within group (order by ttft_ms)` })
      .from(performanceSamples)
      .where(and(eq(performanceSamples.model, model), eq(performanceSamples.ok, true)));
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
    }));
  }
}
