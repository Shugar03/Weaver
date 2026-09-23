// S49 — migration runner: la lógica de qué aplicar es pura y testeable.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pendingMigrations } from "../src/migrate.ts";

describe("S49 pendingMigrations", () => {
  const files = ["0003_x.sql", "0001_init.sql", "0002_b.sql", "notas.txt"];

  it("ordena por nombre y filtra no-sql", () => {
    assert.deepEqual(pendingMigrations(new Set(), files), ["0001_init.sql", "0002_b.sql", "0003_x.sql"]);
  });

  it("ya aplicadas se skipean — idempotente", () => {
    const applied = new Set(["0001_init.sql", "0002_b.sql"]);
    assert.deepEqual(pendingMigrations(applied, files), ["0003_x.sql"]);
  });

  it("todo aplicado → vacío", () => {
    assert.deepEqual(pendingMigrations(new Set(files.filter((f) => f.endsWith(".sql"))), files), []);
  });
});
