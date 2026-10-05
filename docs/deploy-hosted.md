# Deploy hosteado — links permanentes (sin tunnels que expiran)

Arquitectura de 3 piezas — cada una va donde puede, no donde "da":

```
jueces/usuarios → weaver.vercel.app          ← web (Vercel, gratis, permanente)
                      ↓ NEXT_PUBLIC_GATEWAY
        gateway en Railway (Node persistente) ← WS, billing, routing, escrow
                      ↑ wss:// dial-out desde la Mac
        tu Mac: weaver-forge up --gateway wss://…
        (ollama + flux2 = el forge remoto; GPU queda en tu casa)
```

**Por qué no "todo en Vercel"**: el gateway mantiene WebSockets persistentes con
los forges, subprocesos y estado vivo en memoria — Vercel Functions son
stateless ≤60s. No es configuración, es arquitectura: como un nodo blockchain,
necesita un proceso largo.

---

## Paso 1 — Gateway en Railway (~10 min)

1. `railway.app` → login con GitHub → **New Project → Deploy from GitHub repo**
   → `Shugar03/Weaver`. Detecta `railway.toml` → usa `apps/gateway/Dockerfile`.
2. **Variables** (Settings → Variables):

   | Var | Valor | Para qué |
   |---|---|---|
   | `REMOTE_ONLY` | `1` | no registrar forges locales fantasmas |
   | `HOST` | `0.0.0.0` | el Dockerfile ya lo pone; redundante por si acaso |
   | `DATABASE_URL` | `postgres://…` (Neon/Railway PG) | cuentas/billing/journal persistentes — **sin esto las cuentas mueren en cada restart** |
   | `MODEL_PRICING` | ver `.env.example` | billing por token medido |
   | `MODEL_CATALOG` | `apps/gateway/catalog.example.json` | metadata del marketplace |
   | `DEPOSIT_ADDRESS` + `USDC_ISSUER` | G… | deposit watcher → acredita topups USDC |
   | `SETTLEMENT_SECRET` + `SETTLEMENT_CONTRACT` | S…/C… | escrow on-chain (deploy v5 primero) |
   | `CORS_ORIGIN` | `https://tu-app.vercel.app` | cuando la web exista |
   | `RATE_LIMIT_RPM` | `120` | por caller (key o IP); default ya activo — `0` lo apaga |
   | `TLS_CERT` + `TLS_KEY` | paths a pem | TLS nativo (wss:// para forges); Railway termina TLS en el proxy — solo si exponés el puerto directo |

   `PORT` lo inyecta Railway — no setear.

3. **Postgres**: Railway → New → Database → PostgreSQL → copiar `DATABASE_URL`.
   Migraciones: correr UNA vez local o desde Railway shell:
   `pnpm --filter @weaver/db migrate` (o `psql $DATABASE_URL -f` por archivo).
4. Settings → Networking → **Generate Domain** → `weaver-gw.up.railway.app`.
   Verificar: `curl https://weaver-gw.up.railway.app/` → `{"service":"weaver-gateway"…}`.

## Paso 2 — La Mac como forge remoto

El forge hace **dial-out** — no hace falta IP fija ni puertos abiertos:

```bash
weaver-forge init --gateway wss://weaver-gw.up.railway.app
weaver-forge up            # attestation + heartbeat + acepta jobs
# opcional settlement: weaver-forge up --contract C... (self-register + self-claim)
```

`curl https://weaver-gw.up.railway.app/v1/forges` → el forge aparece en segundos.

## Paso 3 — Web en Vercel (~5 min)

1. `vercel.com` → Add New → Project → import `Shugar03/Weaver`.
2. **Root Directory: `apps/web`** (detecta el monorepo pnpm solo).
3. Environment Variables:
   - `NEXT_PUBLIC_GATEWAY` = `https://weaver-gw.up.railway.app`
   - `WEAVER_GATEWAY` = `https://weaver-gw.up.railway.app`
4. Deploy → `weaver-xyz.vercel.app` permanente.

## Paso 4 — Verificación

```bash
curl https://weaver-gw.up.railway.app/v1/catalog   # modelos del forge remoto
curl https://weaver-xyz.vercel.app/models          # marketplace live
# chat en la web → stream real → aparece en /network#ledger
```

## Notas honestas

- **Railway free/trial**: ~$5 de crédito — suficiente para el checkpoint; si se
  acaba, alternativas: Render free (duerme tras 15min idle — el WS de forge se
  re-conecta pero el primer request es lento) o Fly.io.
- **Sin DATABASE_URL**: el gateway corre igual pero cuentas/keys/ledger son
  in-memory — cada redeploy borra usuarios. Para demo con billing: PG sí o sí.
- **El forge local apaga con la laptop**: si la Mac duerme, la fleet queda
  vacía honesta (catálogo muestra modelos sin providers — eso también es la
  demo: forges intermitentes son el caso de uso real).
- **Quick tunnels siguen siendo el plan B** de localhost (deploy-checkpoint2.md).
