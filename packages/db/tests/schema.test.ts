// S16a — el schema existe y tiene las columnas que los adapters usan.
// Sin DB: valida el contrato Drizzle↔SQL antes de tocar Supabase.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getTableColumns } from "drizzle-orm";
import { apiKeys, performanceSamples } from "../src/schema.ts";

describe("S16a schema", () => {
  it("api_keys: id/owner/hash/createdAt/revoked", () => {
    const cols = Object.keys(getTableColumns(apiKeys)).sort();
    assert.deepEqual(cols, ["createdAt", "hash", "id", "owner", "revoked"]);
  });
  it("performance_samples: settle (S17b) + payerTx (S23) + receipt (spec 009) + calibration (spec 015)", () => {
    const cols = Object.keys(getTableColumns(performanceSamples)).sort();
    assert.deepEqual(cols, [
      "decodeMs", "forgeId", "fundTx", "genTokens", "id", "jobId", "keyId", "model",
      "ok", "payerTx", "predictedMs", "proofSig", "releaseTx", "resultHash", "settleStatus", "ts", "ttftMs",
    ]);
  });
});
