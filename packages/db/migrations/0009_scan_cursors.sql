-- S52 (spec 005): cursores durables de scan on-chain. Cada watcher/reconciler
-- guarda su head procesada por nombre — un restart retoma desde cursor-overlap
-- en vez de re-escanear el lookback completo (miles de RPCs) o peor: génesis.
CREATE TABLE IF NOT EXISTS scan_cursors (
  name TEXT PRIMARY KEY,           -- p.ej. 'evm-reconcile', 'evm-deposits'
  head TEXT NOT NULL,              -- bigint como decimal string (sin NUMERIC overflow)
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
