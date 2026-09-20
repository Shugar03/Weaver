// Module DB — schema Drizzle (ADR-0002). S16a: solo lo que el gateway usa vivo
// (api_keys, performance_samples). jobs/forges/instances/settlements post-hackathon.
import { bigint, boolean, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const apiKeys = pgTable("api_keys", {
  id: text("id").primaryKey(),
  owner: text("owner").notNull(),
  hash: text("hash").notNull(), // SHA-256 hex, jamás el secreto
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  revoked: boolean("revoked").notNull().default(false),
});

export const performanceSamples = pgTable(
  "performance_samples",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    forgeId: text("forge_id").notNull(),
    model: text("model").notNull(),
    ttftMs: bigint("ttft_ms", { mode: "number" }).notNull(),
    ok: boolean("ok").notNull(),
    ts: bigint("ts", { mode: "number" }).notNull(),
    keyId: text("key_id"),
  },
  (t) => [index("samples_model_ts_idx").on(t.model, t.ts)],
);
