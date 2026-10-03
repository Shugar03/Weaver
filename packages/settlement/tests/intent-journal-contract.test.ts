// S51 — contrato IntentJournal contra implementaciones reales.
// La MISMA suite corre sobre InMemory (siempre) y Postgres (con
// TEST_DATABASE_URL/DATABASE_URL) — si el journal durable diverge del
// semántico in-memory, el reconciler y el sweep heredan el bug.
// pg real: TEST_DATABASE_URL=postgres://…/db node --test tests/intent-journal-contract.test.ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { InMemoryIntentJournal, PostgresIntentJournal, type IntentJournal, type SettleIntent } from "../src/journal.ts";

const PG_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const intent = (n: number): Omit<SettleIntent, "jobId" | "fundTx"> => ({
  jobKey: `0xkey${n}`,
  worker: `0xworker${n}`,
  resultHash: `hash${n}`,
  forgeSig: `sig${n}`,
  createdAt: Date.now() - n,
});

function contract(name: string, make: () => Promise<{ j: IntentJournal; cleanup: () => Promise<void> }>) {
  test(`${name}: recordIntent → intentsWithoutJob, nada en pending`, async () => {
    const { j, cleanup } = await make();
    await j.recordIntent(intent(1));
    const orphans = await j.intentsWithoutJob();
    assert.equal(orphans.length, 1);
    assert.equal(orphans[0].jobKey, "0xkey1");
    assert.deepEqual(await j.pending(), []);
    assert.deepEqual(await j.knownJobIds(), []);
    await cleanup();
  });

  test(`${name}: attachJob liga jobId+fundTx → pending`, async () => {
    const { j, cleanup } = await make();
    await j.recordIntent(intent(2));
    await j.attachJob("0xkey2", 42, "0xfund");
    assert.deepEqual(await j.intentsWithoutJob(), []);
    const p = await j.pending();
    assert.equal(p.length, 1);
    assert.equal(p[0].jobId, 42);
    assert.equal(p[0].fundTx, "0xfund");
    assert.equal(p[0].worker, "0xworker2");
    assert.deepEqual(await j.knownJobIds(), [42]);
    await cleanup();
  });

  test(`${name}: markReleased saca el job de pending`, async () => {
    const { j, cleanup } = await make();
    await j.recordIntent(intent(3));
    await j.attachJob("0xkey3", 7, "0xf");
    await j.markReleased(7, "0xrel");
    assert.deepEqual(await j.pending(), []);
    assert.deepEqual(await j.knownJobIds(), [7], "conocido — el reconciler no lo re-matchea");
    await cleanup();
  });

  test(`${name}: markFailed saca el job de pending`, async () => {
    const { j, cleanup } = await make();
    await j.recordIntent(intent(4));
    await j.attachJob("0xkey4", 8, "0xf");
    await j.markFailed(8, "release revert");
    assert.deepEqual(await j.pending(), []);
    assert.deepEqual(await j.knownJobIds(), [8]);
    await cleanup();
  });

  test(`${name}: record() compat SettleJournal → funded directo`, async () => {
    const { j, cleanup } = await make();
    await j.record({ jobId: 9, worker: "0xw", resultHash: "h", forgeSig: "s", fundTx: "0xf", createdAt: Date.now() });
    const p = await j.pending();
    assert.equal(p.length, 1);
    assert.equal(p[0].jobId, 9);
    await j.markReleased(9, "0xr");
    assert.deepEqual(await j.pending(), []);
    await cleanup();
  });

  test(`${name}: discardIntent cierra el huérfano (audit trail, no re-advierte)`, async () => {
    const { j, cleanup } = await make();
    await j.recordIntent(intent(5));
    await j.discardIntent("0xkey5", "stale: nunca minó fundJob");
    assert.deepEqual(await j.intentsWithoutJob(), []);
    assert.deepEqual(await j.pending(), [], "un intent descartado jamás se libera");
    await cleanup();
  });

  test(`${name}: attachJob sobre jobKey inexistente es no-op seguro`, async () => {
    const { j, cleanup } = await make();
    await j.attachJob("0xghost", 77, "0xf");
    assert.deepEqual(await j.pending(), []);
    assert.deepEqual(await j.knownJobIds(), [], "no materializa jobs que nunca tuvieron proof");
    await cleanup();
  });
}

contract("InMemoryIntentJournal", async () => ({
  j: new InMemoryIntentJournal(),
  cleanup: async () => {},
}));

if (!PG_URL) {
  test("PostgresIntentJournal", (t) => t.skip("sin TEST_DATABASE_URL — correr contra pg real"));
} else {
  // Setup pg real: migraciones ya aplicadas por el runner externo
  // (DATABASE_URL=… node packages/db/migrate.mjs). Acá solo se limpia la tabla.
  const { dbFromUrl, closeDb, settleIntents } = await import("@weaver/db");
  const db = dbFromUrl(PG_URL);
  const wipe = () => db.delete(settleIntents).then(() => {});

  before(wipe);
  after(async () => {
    await wipe();
    await closeDb();
  });

  contract("PostgresIntentJournal", async () => ({
    j: new PostgresIntentJournal(db),
    cleanup: wipe,
  }));

  test("PostgresIntentJournal: persiste entre instancias (restart)", async () => {
    await wipe();
    const a = new PostgresIntentJournal(db);
    await a.recordIntent(intent(9));
    await a.attachJob("0xkey9", 55, "0xfund55");
    // "Restart": instancia nueva, cero estado en memoria — misma DB.
    const b = new PostgresIntentJournal(db);
    const p = await b.pending();
    assert.equal(p.length, 1);
    assert.equal(p[0].jobId, 55);
    assert.equal(p[0].forgeSig, "sig9", "el proof sobrevivió al proceso");
    assert.deepEqual(await b.knownJobIds(), [55]);
    await wipe();
  });
}
