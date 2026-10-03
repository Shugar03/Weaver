import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@weaver/db";
import type { Db } from "@weaver/db";
import {
  InMemoryIntentJournal,
  PostgresIntentJournal,
  InMemorySettleJournal,
  PostgresSettleJournal,
  type IntentJournal,
  type SettleJournal,
} from "../src/journal.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "../../db/migrations");

describe("Spec 004 — PostgresIntentJournal & PostgresSettleJournal Contract Tests (PGlite WASM)", () => {
  let pgClient: PGlite;
  let pgDb: Db;

  before(async () => {
    pgClient = new PGlite();
    const sql0005 = fs.readFileSync(path.join(MIGRATIONS_DIR, "0005_settle_jobs.sql"), "utf8");
    const sql0008 = fs.readFileSync(path.join(MIGRATIONS_DIR, "0008_settle_intents.sql"), "utf8");
    await pgClient.exec(sql0005);
    await pgClient.exec(sql0008);
    pgDb = drizzle(pgClient, { schema }) as unknown as Db;
  });

  after(async () => {
    if (pgClient) {
      await pgClient.close();
    }
  });

  describe("InMemoryIntentJournal contract compliance", () => {
    let journal: IntentJournal;

    beforeEach(() => {
      journal = new InMemoryIntentJournal();
    });

    test("recordIntent → persiste intent sin jobId", async () => {
      const jobKey = "0x" + "a".repeat(64);
      const worker = "0x784E0a01c683df116fA5bb5A91180d6Fc06BF5CB";
      const resultHash = "0x" + "b".repeat(64);
      const forgeSig = "0x" + "c".repeat(130);
      const createdAt = Date.now();

      await journal.recordIntent({ jobKey, worker, resultHash, forgeSig, createdAt });

      const withoutJob = await journal.intentsWithoutJob();
      assert.equal(withoutJob.length, 1);
      assert.equal(withoutJob[0].jobKey, jobKey);
      assert.equal(withoutJob[0].worker, worker);
      assert.equal(withoutJob[0].jobId, undefined);

      // jobKey duplicado = bug del caller → rechaza (PK semantics; jamás clobber)
      await assert.rejects(
        journal.recordIntent({ jobKey, worker, resultHash, forgeSig, createdAt }),
        (e: unknown) => {
          // drizzle wrappea el error PG — el 'duplicate key' puede ir en cause
          const msgs = [e, (e as { cause?: unknown })?.cause]
            .map((c) => (c instanceof Error ? c.message : String(c)));
          return msgs.some((m) => /duplicado|duplicate key/i.test(m));
        }
      );
      const withoutJob2 = await journal.intentsWithoutJob();
      assert.equal(withoutJob2.length, 1);
    });

    test("attachJob → liga jobId y fundTx, sale de intentsWithoutJob, entra en pending", async () => {
      const jobKey = "0x" + "b".repeat(64);
      const worker = "0x784E0a01c683df116fA5bb5A91180d6Fc06BF5CB";
      const resultHash = "0x" + "b".repeat(64);
      const forgeSig = "0x" + "c".repeat(130);
      const createdAt = Date.now();

      await journal.recordIntent({ jobKey, worker, resultHash, forgeSig, createdAt });
      await journal.attachJob(jobKey, 42, "0xfundtx1");

      const withoutJob = await journal.intentsWithoutJob();
      assert.equal(withoutJob.length, 0);

      const pending = await journal.pending();
      assert.equal(pending.length, 1);
      assert.equal(pending[0].jobId, 42);
      assert.equal(pending[0].fundTx, "0xfundtx1");
    });

    test("markReleased → sale de pending tras liberación", async () => {
      const jobKey = "0x" + "c".repeat(64);
      const worker = "0x784E0a01c683df116fA5bb5A91180d6Fc06BF5CB";
      const resultHash = "0x" + "b".repeat(64);
      const forgeSig = "0x" + "c".repeat(130);

      await journal.recordIntent({ jobKey, worker, resultHash, forgeSig, createdAt: Date.now() });
      await journal.attachJob(jobKey, 10, "0xfund10");

      let pending = await journal.pending();
      assert.equal(pending.length, 1);

      await journal.markReleased(10, "0xreleasetx10");
      pending = await journal.pending();
      assert.equal(pending.length, 0);
    });

    test("markFailed → sale de pending tras fallo de liquidación", async () => {
      const jobKey = "0x" + "d".repeat(64);
      const worker = "0x784E0a01c683df116fA5bb5A91180d6Fc06BF5CB";
      const resultHash = "0x" + "b".repeat(64);
      const forgeSig = "0x" + "c".repeat(130);

      await journal.recordIntent({ jobKey, worker, resultHash, forgeSig, createdAt: Date.now() });
      await journal.attachJob(jobKey, 11, "0xfund11");

      let pending = await journal.pending();
      assert.equal(pending.length, 1);

      await journal.markFailed(11, "BadSignature");
      pending = await journal.pending();
      assert.equal(pending.length, 0);
    });

    test("discardIntent → marca intent huérfano como failed", async () => {
      const jobKey = "0x" + "e".repeat(64);
      const worker = "0x784E0a01c683df116fA5bb5A91180d6Fc06BF5CB";
      const resultHash = "0x" + "b".repeat(64);
      const forgeSig = "0x" + "c".repeat(130);

      await journal.recordIntent({ jobKey, worker, resultHash, forgeSig, createdAt: Date.now() });
      assert.equal((await journal.intentsWithoutJob()).length, 1);

      await journal.discardIntent(jobKey, "sin funded on-chain tras crash");
      assert.equal((await journal.intentsWithoutJob()).length, 0);
    });

    test("record (compat SettleJournal directo) → persiste funded", async () => {
      await journal.record({
        jobId: 100,
        worker: "0x784E0a01c683df116fA5bb5A91180d6Fc06BF5CB",
        resultHash: "0x" + "1".repeat(64),
        forgeSig: "0x" + "2".repeat(130),
        fundTx: "0xfund100",
        createdAt: Date.now(),
      });

      const pending = await journal.pending();
      assert.equal(pending.length, 1);
      assert.equal(pending[0].jobId, 100);
    });
  });

  describe("PostgresIntentJournal (PGlite) contract compliance", () => {
    let journal: IntentJournal;

    beforeEach(async () => {
      await pgClient.exec("DELETE FROM settle_intents; DELETE FROM settle_jobs;");
      journal = new PostgresIntentJournal(pgDb);
    });

    test("recordIntent → persiste intent sin jobId", async () => {
      const jobKey = "0x" + "a".repeat(64);
      const worker = "0x784E0a01c683df116fA5bb5A91180d6Fc06BF5CB";
      const resultHash = "0x" + "b".repeat(64);
      const forgeSig = "0x" + "c".repeat(130);
      const createdAt = Date.now();

      await journal.recordIntent({ jobKey, worker, resultHash, forgeSig, createdAt });

      const withoutJob = await journal.intentsWithoutJob();
      assert.equal(withoutJob.length, 1);
      assert.equal(withoutJob[0].jobKey, jobKey);
      assert.equal(withoutJob[0].worker, worker);
      assert.equal(withoutJob[0].jobId, undefined);

      // jobKey duplicado = bug del caller → rechaza (PK semantics)
      await assert.rejects(
        journal.recordIntent({ jobKey, worker, resultHash, forgeSig, createdAt }),
        (e: unknown) => {
          // drizzle wrappea el error PG — el 'duplicate key' puede ir en cause
          const msgs = [e, (e as { cause?: unknown })?.cause]
            .map((c) => (c instanceof Error ? c.message : String(c)));
          return msgs.some((m) => /duplicado|duplicate key/i.test(m));
        }
      );
      const withoutJob2 = await journal.intentsWithoutJob();
      assert.equal(withoutJob2.length, 1);
    });

    test("attachJob → liga jobId y fundTx, sale de intentsWithoutJob, entra en pending", async () => {
      const jobKey = "0x" + "b".repeat(64);
      const worker = "0x784E0a01c683df116fA5bb5A91180d6Fc06BF5CB";
      const resultHash = "0x" + "b".repeat(64);
      const forgeSig = "0x" + "c".repeat(130);
      const createdAt = Date.now();

      await journal.recordIntent({ jobKey, worker, resultHash, forgeSig, createdAt });
      await journal.attachJob(jobKey, 42, "0xfundtx1");

      const withoutJob = await journal.intentsWithoutJob();
      assert.equal(withoutJob.length, 0);

      const pending = await journal.pending();
      assert.equal(pending.length, 1);
      assert.equal(pending[0].jobId, 42);
      assert.equal(pending[0].fundTx, "0xfundtx1");
    });

    test("markReleased → sale de pending tras liberación", async () => {
      const jobKey = "0x" + "c".repeat(64);
      const worker = "0x784E0a01c683df116fA5bb5A91180d6Fc06BF5CB";
      const resultHash = "0x" + "b".repeat(64);
      const forgeSig = "0x" + "c".repeat(130);

      await journal.recordIntent({ jobKey, worker, resultHash, forgeSig, createdAt: Date.now() });
      await journal.attachJob(jobKey, 10, "0xfund10");

      let pending = await journal.pending();
      assert.equal(pending.length, 1);

      await journal.markReleased(10, "0xreleasetx10");
      pending = await journal.pending();
      assert.equal(pending.length, 0);
    });

    test("markFailed → sale de pending tras fallo de liquidación", async () => {
      const jobKey = "0x" + "d".repeat(64);
      const worker = "0x784E0a01c683df116fA5bb5A91180d6Fc06BF5CB";
      const resultHash = "0x" + "b".repeat(64);
      const forgeSig = "0x" + "c".repeat(130);

      await journal.recordIntent({ jobKey, worker, resultHash, forgeSig, createdAt: Date.now() });
      await journal.attachJob(jobKey, 11, "0xfund11");

      let pending = await journal.pending();
      assert.equal(pending.length, 1);

      await journal.markFailed(11, "BadSignature");
      pending = await journal.pending();
      assert.equal(pending.length, 0);
    });

    test("discardIntent → marca intent huérfano como failed", async () => {
      const jobKey = "0x" + "e".repeat(64);
      const worker = "0x784E0a01c683df116fA5bb5A91180d6Fc06BF5CB";
      const resultHash = "0x" + "b".repeat(64);
      const forgeSig = "0x" + "c".repeat(130);

      await journal.recordIntent({ jobKey, worker, resultHash, forgeSig, createdAt: Date.now() });
      assert.equal((await journal.intentsWithoutJob()).length, 1);

      await journal.discardIntent(jobKey, "sin funded on-chain tras crash");
      assert.equal((await journal.intentsWithoutJob()).length, 0);
    });

    test("record (compat SettleJournal directo) → persiste funded", async () => {
      await journal.record({
        jobId: 100,
        worker: "0x784E0a01c683df116fA5bb5A91180d6Fc06BF5CB",
        resultHash: "0x" + "1".repeat(64),
        forgeSig: "0x" + "2".repeat(130),
        fundTx: "0xfund100",
        createdAt: Date.now(),
      });

      const pending = await journal.pending();
      assert.equal(pending.length, 1);
      assert.equal(pending[0].jobId, 100);
    });
  });

  describe("PostgresSettleJournal (Stellar/Soroban table) contract compliance", () => {
    let journal: SettleJournal;

    beforeEach(async () => {
      await pgClient.exec("DELETE FROM settle_intents; DELETE FROM settle_jobs;");
      journal = new PostgresSettleJournal(pgDb);
    });

    test("record → markReleased → markFailed → pending", async () => {
      await journal.record({
        jobId: 1,
        worker: "GWORKER1",
        resultHash: "hash1",
        forgeSig: "sig1",
        fundTx: "txfund1",
        createdAt: Date.now(),
      });
      await journal.record({
        jobId: 2,
        worker: "GWORKER2",
        resultHash: "hash2",
        forgeSig: "sig2",
        fundTx: "txfund2",
        createdAt: Date.now(),
      });

      let pending = await journal.pending();
      assert.equal(pending.length, 2);

      await journal.markReleased(1, "txrel1");
      pending = await journal.pending();
      assert.equal(pending.length, 1);
      assert.equal(pending[0].jobId, 2);

      await journal.markFailed(2, "bad state");
      pending = await journal.pending();
      assert.equal(pending.length, 0);
    });
  });
});
