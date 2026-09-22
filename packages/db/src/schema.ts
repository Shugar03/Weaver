// Module DB — schema Drizzle (ADR-0002). S16a: solo lo que el gateway usa vivo
// (api_keys, performance_samples). jobs/forges/instances/settlements post-hackathon.
import { bigint, boolean, index, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

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
    payerTx: text("payer_tx"), // S23: tx x402 cliente→operador
    fundTx: text("fund_tx"),
    releaseTx: text("release_tx"),
    settleStatus: text("settle_status"),
  },
  (t) => [index("samples_model_ts_idx").on(t.model, t.ts)],
);

// S44 (ADR-0006, I3): journal de escrows — referencia durable a todo fund_job
// para que un crash entre fund y release jamás deje plata huérfana.
export const settleJobs = pgTable("settle_jobs", {
  jobId: bigint("job_id", { mode: "number" }).primaryKey(),
  worker: text("worker").notNull(),
  resultHash: text("result_hash").notNull(),
  forgeSig: text("forge_sig").notNull(),
  fundTx: text("fund_tx").notNull(),
  releaseTx: text("release_tx"),
  state: text("state").notNull().default("funded"), // funded|released|failed
  failReason: text("fail_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// S30: identidades de forges remotos (ADR-0005). El estado vivo (capacidad,
// inFlight) es efímero por heartbeat — acá solo persiste la identidad.
export const forges = pgTable("forges", {
  pubkey: text("pubkey").primaryKey(), // G... = identidad + payout address
  displayName: text("display_name"),
  attested: boolean("attested").notNull().default(false),
  // S46: strikes de audit sobreviven al restart — un forge que mintió no
  // recupera la confianza por reboot del gateway.
  strikes: integer("strikes").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
});

// S47 (ADR-0007): cuentas de usuario — el consumidor de la red. Anónima por
// defecto (mgmt token hasheado), wallet linkeable (firma de nonce).
export const accounts = pgTable("accounts", {
  id: text("id").primaryKey(), // acct_...
  mgmtTokenHash: text("mgmt_token_hash"), // sha256 del wvr_acct_ — jamás el secreto
  walletPubkey: text("wallet_pubkey"), // G... linkeada — depósitos por memo=pubkey
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const accountSessions = pgTable("account_sessions", {
  tokenHash: text("token_hash").primaryKey(), // sha256 del wvr_sess_
  accountId: text("account_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

// Ledger append-only de créditos: topup (depósito USDC on-chain) y debit
// (consumo post-serve medido). Dedup por (kind, ref): topup ref = tx hash,
// debit ref = jobId — reintentar jamás acredita/debita dos veces.
export const creditEvents = pgTable(
  "credit_events",
  {
    id: serial("id").primaryKey(),
    accountId: text("account_id").notNull(),
    kind: text("kind").notNull(), // topup | debit
    amount: bigint("amount", { mode: "bigint" }).notNull(), // stroops
    ref: text("ref").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("credit_events_kind_ref").on(t.kind, t.ref)],
);
