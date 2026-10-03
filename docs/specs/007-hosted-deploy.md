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

## Estado (verificado live)

- **Demo público temporal**: `cloudflared` quick tunnel → `https://represents-organizations-comes-testing.trycloudflare.com` (efímero — muere con el proceso local; NO es hosting estable).
- Verificado por la URL pública: `/v1/forges` (2 forges HOT), handshake `wss://`, job chat 200, settle on-chain.
- `scripts/smoke-hosted.mjs` endurecido: identifica la exec del propio run (`ts >= t0`) y espera `settle.status` terminal — **SMOKE PASS con settle=settled**.
- El smoke cazó un bug real: `job_key = keccak(sig)` colisionaba la PK de `settle_intents` en outputs idénticos (ECDSA determinista) — fix en `evm.ts` (key único por llamada), test de regresión en `evm-escrow.test.ts`, verificado live: jobs 13 y 14 released en pg.
- Env dual correcto: `SETTLEMENT_CONTRACT` = escrow EVM, `STELLAR_CONTRACT` = escrow Soroban, `STELLAR_SECRET` = admin Stellar (NO `SETTLEMENT_SECRET`, que es la key EVM).
- **Pendiente para hosting estable**: Railway/Render/Fly (gateway+pg) + Vercel (web) — scaffolding listo (`railway*.toml`, Dockerfiles), falta cuenta/credenciales del equipo.

## Decisión demo: Monad-only

El fleet demo corre `SETTLE_CHAIN=evm` — toda tx verificable en explorer Monad.
La vía Stellar y el `SettleDispatcher` quedan en el código (dual-verified en
testnet) como prueba de diseño chain-agnostic, pero no corren en la demo:
un solo chain = una secret, un RPC, cero ambigüedad de envs para jueces.

## Runbook de restart (demo.env — gitignored)

```bash
./scripts/demo-up.sh                     # gateway :3501, settle=ON(evm), pg
node apps/forge/src/cli.ts up --config /tmp/forge-x402.json   # live1
node apps/forge/src/cli.ts up --config /tmp/forge-evm2.json   # live2
cloudflared tunnel --url http://127.0.0.1:3501                 # URL pública
node scripts/smoke-hosted.mjs <url-pública>                  # verificación
```

Nota: los forges NO reconectan solos tras un restart del gateway — hay que
rebotearlos (relaunch del `cli.ts up`). Los configs de forge viven en /tmp
(ephemeral del operador).
