// Module DB — cliente. Lazy y único: se conecta en el primer query, no en import.
// Sin DATABASE_URL no se construye (el composition root decide in-memory).
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.ts";

export type Db = PostgresJsDatabase<typeof schema>;

// Cache por URL: gateway usa DATABASE_URL (weaver_dev) e INDEXER_DATABASE_URL
// (weaver_indexer) a la vez — cachear sin key devolvería la primera para ambas.
const cache = new Map<string, { db: Db; close: () => Promise<void> }>();

export function dbFromUrl(url: string): Db {
  const hit = cache.get(url);
  if (hit) return hit.db;
  const client = postgres(url, { max: 5, idle_timeout: 20, connect_timeout: 10 });
  cache.set(url, { db: drizzle(client, { schema }), close: () => client.end() });
  return cache.get(url)!.db;
}

export async function closeDb(): Promise<void> {
  const all = [...cache.values()];
  cache.clear();
  await Promise.all(all.map((c) => c.close()));
}
