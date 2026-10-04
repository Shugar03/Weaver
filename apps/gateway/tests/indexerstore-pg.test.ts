// spec 008 — PgIndexerStore contract test contra PGlite (Postgres WASM).
// Crea las tablas envio-shaped BASE (las que despliega envio de verdad:
// Job/Deposit/Feedback/Agent/Forge + envio_checkpoints) y verifica que
// el store compute los agregados correcto — sin depender de entidades
// derivadas que puedan no estar en un deployment dado.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Db } from "@weaver/db";
import { PgIndexerStore } from "../src/indexerstore.ts";

describe("spec 008 — PgIndexerStore (PGlite, base envio schema)", () => {
  let client: PGlite;
  let store: PgIndexerStore;

  before(async () => {
    client = new PGlite();
    await client.exec(`
      CREATE TABLE "Job" (
        id text PRIMARY KEY, "jobId" numeric NOT NULL, client text NOT NULL,
        worker text NOT NULL, amount numeric NOT NULL, state text NOT NULL,
        "fundTx" text NOT NULL, "fundedAtBlock" numeric NOT NULL,
        "fundedAtTs" numeric NOT NULL, "releaseTx" text,
        "releasedAtBlock" numeric, "resultHash" text, "refundTx" text
      );
      CREATE TABLE "Deposit" (
        id text PRIMARY KEY, account text NOT NULL, payer text NOT NULL,
        amount numeric NOT NULL, "txHash" text NOT NULL,
        "blockNumber" numeric NOT NULL, timestamp numeric NOT NULL
      );
      CREATE TABLE "Forge" (
        id text PRIMARY KEY, worker text NOT NULL, signer text NOT NULL,
        "registeredTx" text NOT NULL, "registeredAtBlock" numeric NOT NULL
      );
      CREATE TABLE "Feedback" (
        id text PRIMARY KEY, "agentId" numeric NOT NULL, "clientAddress" text NOT NULL,
        "feedbackIndex" numeric NOT NULL, value numeric NOT NULL, "valueDecimals" int NOT NULL,
        tag1 text NOT NULL, tag2 text NOT NULL, endpoint text NOT NULL, "feedbackURI" text NOT NULL,
        "feedbackHash" text NOT NULL, "txHash" text NOT NULL, "blockNumber" numeric NOT NULL,
        revoked boolean NOT NULL
      );
      CREATE TABLE "Agent" (
        id text PRIMARY KEY, "agentId" numeric NOT NULL, owner text NOT NULL,
        "agentURI" text NOT NULL, "registeredTx" text NOT NULL, "registeredAtBlock" numeric NOT NULL
      );
      CREATE TABLE envio_checkpoints (
        chain_id int NOT NULL, id bigint PRIMARY KEY,
        block_number int NOT NULL, block_hash text, events_processed int NOT NULL
      );

      -- 7 jobs: 6 released (vol 70M) + 1 refunded → funded=7
      -- 0xbbb: 4 released (50M) + 1 refunded · 0xaaa: 2 released (20M)
      INSERT INTO "Job" (id, "jobId", client, worker, amount, state, "fundTx", "fundedAtBlock", "fundedAtTs") VALUES
        ('j1', 1, '0xC', '0xbbb', 10000000, 'released', '0xf1', 100, 1),
        ('j2', 2, '0xC', '0xbbb', 10000000, 'released', '0xf2', 110, 2),
        ('j3', 3, '0xC', '0xbbb', 10000000, 'released', '0xf3', 120, 3),
        ('j4', 4, '0xC', '0xbbb', 20000000, 'released', '0xf4', 130, 4),
        ('j5', 5, '0xC', '0xbbb', 5000000, 'refunded', '0xf5', 140, 5),
        ('j6', 6, '0xC', '0xaaa', 10000000, 'released', '0xf6', 150, 6),
        ('j7', 7, '0xC', '0xaaa', 10000000, 'released', '0xf7', 300, 7);
      INSERT INTO "Deposit" VALUES
        ('d1', '0xA', '0xP', 150000000, '0xtd', 50, 1),
        ('d2', '0xA', '0xP', 50000000, '0xte', 60, 2);
      -- registro base: sin columnas de stats (las computa el store)
      INSERT INTO "Forge" VALUES
        ('0xaaa', '0xaaa', '0x111', '0xtx1', 100),
        ('0xbbb', '0xbbb', '0x222', '0xtx2', 90),
        ('0xccc', '0xccc', '0x333', '0xtx3', 95);
      INSERT INTO "Feedback" VALUES
        ('f1', 1990, '0xc1', 0, 500, 2, 'speed', 'accuracy', 'https://f/v1', 'ipfs://a', '0x01', '0xtx1', 100, false),
        ('f2', 1990, '0xc2', 1, 40, 1, 'rel', 'speed', 'https://f/v1', 'ipfs://b', '0x02', '0xtx2', 101, false),
        ('f3', 1990, '0xc3', 2, 100, 0, 'x', 'y', 'e', 'u', '0x03', '0xtx3', 102, true),
        ('f4', 7, '0xc9', 0, 10, 0, 'x', 'y', 'e', 'u', '0x04', '0xtx4', 103, false);
      INSERT INTO "Agent" VALUES
        ('1990', 1990, '0xowner', 'https://agent.uri/meta', '0xreg', 50);
      -- checkpoints vacío (envio no persistió ninguno aún) → freshness
      -- cae al max de entidades: fundedAtBlock 300 de j7
    `);
    store = new PgIndexerStore(drizzle(client) as unknown as Db);
  });

  after(async () => {
    await client?.close();
  });

  it("stats → agregados computados desde tablas base + freshness fallback", async () => {
    const { metric, indexedAtBlock } = await store.stats();
    assert.equal(metric.totalJobsFunded, 7);
    assert.equal(metric.totalJobsReleased, 6);
    assert.equal(metric.totalJobsRefunded, 1);
    assert.equal(metric.totalVolumeUsdc, 70_000_000n);
    assert.equal(metric.totalDepositedUsdc, 200_000_000n);
    assert.equal(metric.totalFeedbacks, 4);
    assert.equal(indexedAtBlock, 300); // fallback: max fundedAtBlock (envio_checkpoints vacío)
  });

  it("forges → leaderboard con stats computadas, orden earned desc", async () => {
    const rows = await store.forges();
    assert.equal(rows.length, 3);
    // 0xbbb: 4 released × (10+10+10+20)M = 50M, 1 refunded
    assert.equal(rows[0].worker, "0xbbb");
    assert.equal(rows[0].totalEarnedUsdc, 50_000_000n);
    assert.equal(rows[0].completedJobsCount, 4);
    assert.equal(rows[0].refundedJobsCount, 1);
    // 0xaaa: 2 released × 10M = 20M
    assert.equal(rows[1].worker, "0xaaa");
    assert.equal(rows[1].totalEarnedUsdc, 20_000_000n);
    assert.equal(rows[1].completedJobsCount, 2);
    // 0xccc: registrado sin jobs → 0 earned, sigue saliendo en el board
    assert.equal(rows[2].worker, "0xccc");
    assert.equal(rows[2].totalEarnedUsdc, 0n);
  });

  it("feedbacks filtrados por agentId — revoked incluido, otro agente excluido", async () => {
    const fbs = await store.feedbacks(1990n);
    assert.equal(fbs.length, 3);
    // ORDER BY blockNumber DESC → el más reciente (102, revocado) primero
    assert.equal(fbs[0].revoked, true);
    assert.equal(fbs[0].blockNumber, 102n);
    // Los dos no-revocados conservan sus decimales reales (2 y 1)
    assert.equal(fbs.find((f) => f.blockNumber === 100n)?.valueDecimals, 2);
    assert.equal(fbs.find((f) => f.blockNumber === 101n)?.valueDecimals, 1);
    const other = await store.feedbacks(9999n);
    assert.equal(other.length, 0);
  });

  it("agent → fila o null honesto", async () => {
    const a = await store.agent(1990n);
    assert.equal(a?.owner, "0xowner");
    assert.equal(a?.agentURI, "https://agent.uri/meta");
    assert.equal(await store.agent(42n), null);
  });

  it("spec 013: reputationScores — join Feedback⋈Agent, Laplace, revoked fuera", async () => {
    const scores = await store.reputationScores();
    // agent 1990 (owner 0xowner): f1=500/10^2=5 + f2=40/10^1=4 → pos 9,
    // f3 REVOCADA no cuenta → (9+1)/(9+0+2) = 10/11 ≈ 0.909
    const s = scores.get("0xowner");
    assert.ok(s !== undefined);
    assert.ok(Math.abs(s - 10 / 11) < 1e-9, `score ${s} ≠ 10/11`);
    // feedback de agente inexistente (agentId 7) no produce worker ni score
    assert.equal(scores.size, 1);
  });
});
