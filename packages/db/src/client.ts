// Module DB — cliente. Lazy y único: se conecta en el primer query, no en import.
// Sin DATABASE_URL no se construye (el composition root decide in-memory).
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.ts";

export type Db = PostgresJsDatabase<typeof schema>;

let cached: { db: Db; close: () => Promise<void> } | null = null;

export function dbFromUrl(url: string): Db {
  if (cached) return cached.db;
  const client = postgres(url, { max: 5, idle_timeout: 20, connect_timeout: 10 });
  cached = { db: drizzle(client, { schema }), close: () => client.end() };
  return cached.db;
}

export async function closeDb(): Promise<void> {
  await cached?.close();
  cached = null;
}
