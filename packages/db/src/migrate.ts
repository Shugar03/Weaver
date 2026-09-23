// S49 — qué migraciones aplicar. Puro: el CLI (migrate.mjs) lista el dir,
// lee _migrations y ejecuta los pendientes en orden. Regla: nombre asc
// (0001_, 0002_…), solo .sql, aplicada = presente en la tabla tracking.
export function pendingMigrations(applied: ReadonlySet<string>, files: string[]): string[] {
  return files
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .filter((f) => !applied.has(f));
}
