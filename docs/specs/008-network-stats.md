# Spec 008 — Network stats: /v1/network/* leyendo índice Envio

## Por qué

El indexer (spec 006) ya produce datos reales en `weaver_indexer` —
`Job`, `Forge`, `Deposit`, `Agent`, `Feedback`, `ProtocolMetric` — pero
nadie los consume. Un juez no abre psql: el dashboard tiene que leer lo
indexado y mostrarlo. La confianza que ya probamos (escrow, reputación)
tiene que ser **visible**, no solo existir.

## Diseño

Gateway lee las tablas envio por SQL directo — cero infra nueva (no
Hasura), mismo proceso, sin CORS. Datos on-chain puros: si envio no
corrió, la fila falta → se reporta lo que hay (zeros + `indexedAtBlock`),
jamás se inventa.

- `IndexerStore` (`apps/gateway/src/indexerstore.ts`):
  - `stats()` → contadores del protocolo + bloque indexado (freshness)
  - `leaderboard()` → forges con `earnedUsdc`, jobs completados, refunds
  - `reputation(agentId)` → feedbacks del agente + score promedio
  - `PgIndexerStore` (drizzle sql, tablas PascalCase con quotes) +
    `InMemoryIndexerStore` (tests/dev)
- Rutas en `createApp` (`deps.indexerStore` opcional — sin store → 404):
  - `GET /v1/network/stats` → `{ funded, released, refunded, volumeUsdc,
    depositedUsdc, feedbacks, indexedAtBlock }`
  - `GET /v1/network/leaderboard` → rows ordenados por earned desc
  - `GET /v1/network/reputation?agentId=N` → `{ agentId, count, avgScore,
    feedbacks }` — `avgScore` = mean(value/10^decimals) por item;
    `revoked` se cuenta en count, no en avg
- `serve.ts`: `INDEXER_DATABASE_URL` → `dbFromUrl` → store. Sin env →
  store ausente (log `indexer=OFF`).
- Web: `StatsStrip` + `Leaderboard` en `/network` — convenciones del
  sitio (font-tech, border-line, "—" honesto cuando falta dato).

## Verificación

- Tests gateway: shape de endpoints, 404 sin store, avg decimal-safe,
  ordering del leaderboard, agentId sin feedbacks → respuesta vacía
  honesta. PGlite para `PgIndexerStore` con tablas fake PascalCase.
- Live: `INDEXER_DATABASE_URL` → `/v1/network/stats` devuelve los jobs
  released reales que ya están en `weaver_indexer`.

## Fuera de scope

- Hasura/GraphQL consumer directo (el GraphQL de envio existe para el
  bounty; el gateway consume las mismas tablas por SQL).
- Envio hosted deploy (pendiente cuenta).
