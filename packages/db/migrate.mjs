#!/usr/bin/env node
// S49 — corre migrations/*.sql en orden, tracking en _migrations.
// Idempotente: re-correr no reaplica. Uso:
//   DATABASE_URL=postgres://… node packages/db/migrate.mjs
// o desde el package: pnpm --filter @weaver/db migrate
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL requerida (postgres://user:pass@host/db)");
  process.exit(1);
}

const dir = fileURLToPath(new URL("./migrations", import.meta.url));
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

const sql = postgres(url, { max: 1 });
try {
  await sql`create table if not exists _migrations (
    file text primary key,
    applied_at timestamptz not null default now()
  )`;
  const applied = new Set((await sql`select file from _migrations`).map((r) => r.file));
  let n = 0;
  for (const f of files) {
    if (applied.has(f)) continue;
    const body = readFileSync(`${dir}/${f}`, "utf8");
    await sql.begin(async (s) => {
      await s.unsafe(body);
      await s`insert into _migrations (file) values (${f})`;
    });
    console.log(`✓ ${f}`);
    n++;
  }
  console.log(n === 0 ? `al día (${files.length} migraciones ya aplicadas)` : `aplicadas ${n} migración(es)`);
} finally {
  await sql.end();
}
