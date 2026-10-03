# Spec 007 — Deploy hosted: demo pública para jueces

## Cuándo

Último paso — después de specs 001-006. Deployar antes es publicar una
demo más débil de lo que puede ser.

## Decisión pendiente del operador

| Opción | Qué implica |
|---|---|
| **Railway** (scaffolding listo) | 2 servicios Docker (gw+web), ~$5/mes, envs en `railway.toml` |
| **Web→Vercel + GW→Railway/Render** | Split: lo que ya se conoce + server para el WS |
| **cloudflared tunnel** | Público YA sin cuentas, pero muere si la máquina se apaga |

## Checklist de producción (independiente del host)

1. **Envs gateway**: `SETTLE_CHAIN=evm`, `REMOTE_ONLY=1`, `SETTLEMENT_SECRET`,
   `SETTLEMENT_CONTRACT`, `OPERATOR_KEY`, `CORS_ORIGIN=<web>`,
   `EVM_ESCROW_FROM_BLOCK`, `RATE_LIMIT_RPM=60`, y **DATABASE_URL** —
   hosted sin pg = journal en memoria = los intents se pierden en restart
   (el reconciler existe para esto, pero pg es lo correcto en producción).
2. **Env web**: `WEAVER_GATEWAY=<url pública del gw>`.
3. **Forges**: repuntar `cfg.gateway` a `https://<gw>` (deriva wss solo);
   corren local del operador — se documenta honesto: "demo fleet hosted
   por el equipo".
4. **Post-deploy verificación**: `GET /v1/forges` público muestra forges
   HOT + `forgeAgentVerified`; POST sin key → 200 (paywall off, rate-limit
   por IP protege); un job completo → release on-chain visible.
5. **NO commitear secrets** — solo por env del host.

## Test plan

Smoke script `scripts/smoke-hosted.mjs <base-url>`: forges, un chat job,
telemetría del settle — falla si algo no es real.
