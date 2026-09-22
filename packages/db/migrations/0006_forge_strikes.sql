-- S46 (ADR-0006): strikes de audit persistidos — un forge que mintió no
-- recupera la confianza por restart del gateway.
ALTER TABLE forges ADD COLUMN IF NOT EXISTS strikes INTEGER NOT NULL DEFAULT 0;
