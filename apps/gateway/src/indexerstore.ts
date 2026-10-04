// spec 008 — IndexerStore: lectura del índice Envio (weaver_indexer).
// Los datos son eventos on-chain decodificados — si envio no corrió, la
// fila falta y se reporta lo que hay. Jamás se fabrica.
// PgIndexerStore lee por SQL crudo (las tablas PascalCase de envio no
// están en el drizzle schema de @weaver/db — es otro esquema, de envio).
import { sql, type SQL } from "drizzle-orm";
import type { Db } from "@weaver/db";

export type NetworkMetric = {
  totalJobsFunded: number;
  totalJobsReleased: number;
  totalJobsRefunded: number;
  totalVolumeUsdc: bigint;
  totalDepositedUsdc: bigint;
  totalFeedbacks: number;
};

export type IndexedForge = {
  worker: string;
  signer: string;
  registeredTx: string;
  registeredAtBlock: bigint;
  totalEarnedUsdc: bigint;
  completedJobsCount: number;
  refundedJobsCount: number;
};

export type IndexedFeedback = {
  agentId: bigint;
  clientAddress: string;
  feedbackIndex: bigint;
  value: bigint;
  valueDecimals: number;
  tag1: string;
  tag2: string;
  endpoint: string;
  feedbackURI: string;
  feedbackHash: string;
  txHash: string;
  blockNumber: bigint;
  revoked: boolean;
};

export type IndexedAgent = { agentId: bigint; owner: string; agentURI: string };

export interface IndexerStore {
  stats(): Promise<{ metric: NetworkMetric; indexedAtBlock: number }>;
  forges(): Promise<IndexedForge[]>;
  feedbacks(agentId: bigint): Promise<IndexedFeedback[]>;
  agent(agentId: bigint): Promise<IndexedAgent | null>;
}

const ZERO: NetworkMetric = {
  totalJobsFunded: 0,
  totalJobsReleased: 0,
  totalJobsRefunded: 0,
  totalVolumeUsdc: 0n,
  totalDepositedUsdc: 0n,
  totalFeedbacks: 0,
};

export class InMemoryIndexerStore implements IndexerStore {
  private readonly seed: {
    metric?: Partial<NetworkMetric>;
    indexedAtBlock?: number;
    forges?: IndexedForge[];
    feedbacks?: IndexedFeedback[];
    agents?: IndexedAgent[];
  };

  constructor(
    seed: {
      metric?: Partial<NetworkMetric>;
      indexedAtBlock?: number;
      forges?: IndexedForge[];
      feedbacks?: IndexedFeedback[];
      agents?: IndexedAgent[];
    } = {},
  ) {
    this.seed = seed;
  }

  async stats() {
    return {
      metric: { ...ZERO, ...this.seed.metric },
      indexedAtBlock: this.seed.indexedAtBlock ?? 0,
    };
  }
  async forges() {
    // Mismo contrato que PgIndexerStore: earned desc (el SQL lo hace con
    // ORDER BY — acá lo replica el contrato del store, no el endpoint).
    return [...(this.seed.forges ?? [])].sort((a, b) =>
      b.totalEarnedUsdc > a.totalEarnedUsdc ? 1 : b.totalEarnedUsdc < a.totalEarnedUsdc ? -1 : 0,
    );
  }
  async feedbacks(agentId: bigint) {
    return (this.seed.feedbacks ?? []).filter((f) => f.agentId === agentId);
  }
  async agent(agentId: bigint) {
    return (this.seed.agents ?? []).find((a) => a.agentId === agentId) ?? null;
  }
}

// Lectura cruda: drizzle sql con nombres envio entre comillas dobles.
const num = (v: unknown): number => Number(v ?? 0);
const big = (v: unknown): bigint => BigInt(v as string | number | bigint ?? 0);

export class PgIndexerStore implements IndexerStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  private async rows<T>(q: SQL): Promise<T[]> {
    const r = (await this.db.execute(q)) as unknown as { rows?: T[] } | T[];
    return Array.isArray(r) ? r : (r.rows ?? []);
  }

  // Los agregados se computan desde las tablas base de envio (Job/Deposit/
  // Feedback/Forge) — cualquier deployment del schema documentado sirve,
  // no dependemos de entidades derivadas ni de migraciones.
  async stats() {
    const [jobs, deps, fbs] = await Promise.all([
      this.rows<{
        funded: number | string;
        released: number | string;
        refunded: number | string;
        volume: string | null;
      }>(
        sql`SELECT COUNT(*) AS funded,
                   COUNT(*) FILTER (WHERE state = 'released') AS released,
                   COUNT(*) FILTER (WHERE state = 'refunded') AS refunded,
                   COALESCE(SUM(amount) FILTER (WHERE state = 'released'), 0) AS volume
            FROM "Job"`,
      ),
      this.rows<{ dep: string | null }>(
        sql`SELECT COALESCE(SUM(amount), 0) AS dep FROM "Deposit"`,
      ),
      this.rows<{ c: number | string }>(sql`SELECT COUNT(*) AS c FROM "Feedback"`),
    ]);
    // Freshness: head de checkpoints de envio; si todavía no persistió ninguno
    // (envio solo checkpointa en intervalos), el max bloque indexado en las
    // entidades — honesto sobre qué tan fresco está el dato que mostramos.
    const indexedAtBlock = await this.rows<{ head: number | string | null }>(
      sql`SELECT MAX(block_number) AS head FROM envio_checkpoints`,
    )
      .catch(() => [{ head: null }])
      .then(async ([c]) => {
        if (c?.head != null) return num(c.head);
        const [m] = await this.rows<{ head: number | string | null }>(
          sql`SELECT GREATEST(
                COALESCE((SELECT MAX("fundedAtBlock") FROM "Job"), 0),
                COALESCE((SELECT MAX("blockNumber") FROM "Deposit"), 0),
                COALESCE((SELECT MAX("blockNumber") FROM "Feedback"), 0)) AS head`,
        );
        return num(m?.head ?? 0);
      });
    const j = jobs[0];
    return {
      metric: {
        totalJobsFunded: num(j?.funded),
        totalJobsReleased: num(j?.released),
        totalJobsRefunded: num(j?.refunded),
        totalVolumeUsdc: big(j?.volume ?? 0),
        totalDepositedUsdc: big(deps[0]?.dep ?? 0),
        totalFeedbacks: num(fbs[0]?.c),
      },
      indexedAtBlock,
    };
  }

  async forges() {
    // Leaderboard: registro (Forge) × agregación de jobs por worker.
    // Forge.id es lowercase; Job.worker llega checksummed → join por LOWER.
    const rows = await this.rows<{
      worker: string;
      signer: string;
      registeredTx: string;
      registeredAtBlock: string;
      earned: string | null;
      completed: number | string;
      refunded: number | string;
    }>(
      sql`SELECT f.worker, f.signer, f."registeredTx", f."registeredAtBlock",
                 COALESCE(SUM(j.amount) FILTER (WHERE j.state = 'released'), 0) AS earned,
                 COUNT(j.id) FILTER (WHERE j.state = 'released') AS completed,
                 COUNT(j.id) FILTER (WHERE j.state = 'refunded') AS refunded
          FROM "Forge" f
          LEFT JOIN "Job" j ON LOWER(j.worker) = LOWER(f.worker)
          GROUP BY f.id, f.worker, f.signer, f."registeredTx", f."registeredAtBlock"
          ORDER BY earned DESC`,
    );
    return rows.map((r) => ({
      worker: r.worker,
      signer: r.signer,
      registeredTx: r.registeredTx,
      registeredAtBlock: big(r.registeredAtBlock),
      totalEarnedUsdc: big(r.earned ?? 0),
      completedJobsCount: num(r.completed),
      refundedJobsCount: num(r.refunded),
    }));
  }

  async feedbacks(agentId: bigint) {
    const rows = await this.rows<{
      agentId: string;
      clientAddress: string;
      feedbackIndex: string;
      value: string;
      valueDecimals: number | string;
      tag1: string;
      tag2: string;
      endpoint: string;
      feedbackURI: string;
      feedbackHash: string;
      txHash: string;
      blockNumber: string;
      revoked: boolean;
    }>(
      sql`SELECT "agentId", "clientAddress", "feedbackIndex", value,
                 "valueDecimals", tag1, tag2, endpoint, "feedbackURI",
                 "feedbackHash", "txHash", "blockNumber", revoked
          FROM "Feedback" WHERE "agentId" = ${agentId.toString()}
          ORDER BY "blockNumber" DESC`,
    );
    return rows.map((r) => ({
      agentId: big(r.agentId),
      clientAddress: r.clientAddress,
      feedbackIndex: big(r.feedbackIndex),
      value: big(r.value),
      valueDecimals: num(r.valueDecimals),
      tag1: r.tag1,
      tag2: r.tag2,
      endpoint: r.endpoint,
      feedbackURI: r.feedbackURI,
      feedbackHash: r.feedbackHash,
      txHash: r.txHash,
      blockNumber: big(r.blockNumber),
      revoked: r.revoked,
    }));
  }

  async agent(agentId: bigint) {
    const [a] = await this.rows<{ agentId: string; owner: string; agentURI: string }>(
      sql`SELECT "agentId", owner, "agentURI" FROM "Agent" WHERE "agentId" = ${agentId.toString()}`,
    );
    return a ? { agentId: big(a.agentId), owner: a.owner, agentURI: a.agentURI } : null;
  }
}
