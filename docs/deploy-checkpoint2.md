# Deploy — Checkpoint 2 (24-sep-2026)

## Links públicos activos

- **Web**: https://conclusions-boys-conflicts-closure.trycloudflare.com
- **Gateway**: https://channels-gathering-seriously-impose.trycloudflare.com

Recorrido principal verificado E2E sobre el link: `/` `/models` `/chat`
`/account` `/developers` `/security` — todos 200, marketplace con datos
live de la fleet (tok/s medidos reales).

## Cómo está montado (honesto)

Quick tunnels de cloudflared — **URLs efímeras ligadas a esta máquina y
sesión**. Mueren si se reinicia el proceso o la laptop se apaga. Para el
checkpoint sirven; para producción hace falta host real (o named tunnel
con dominio propio).

Procesos que deben seguir vivos:

```bash
# gateway (ya corría en :3001)
node apps/gateway/dist/serve.js           # o tsx, según setup local

# web prod (build con NEXT_PUBLIC_GATEWAY horneado = tunnel del gw)
cd apps/web && pnpm exec next start -p 3000

# tunnels
cloudflared tunnel --url http://localhost:3001   # → URL gateway
cloudflared tunnel --url http://localhost:3000   # → URL web (link público)
```

Orden de reconstrucción si muere algo: tunnel gw → capturar URL →
rebuild web con `NEXT_PUBLIC_GATEWAY=<url>` + `WEAVER_GATEWAY=<url>` →
next start → tunnel web.

**Ojo**: otro proceso en esta máquina (roster-basilisk) corre
`pkill -f "cloudflared tunnel --url"` — mató el primer tunnel. Si los
links caen de nuevo, ese es el sospechoso.

## Checklist Checkpoint 2

- [x] Feature freeze — sin features nuevas desde este deploy
- [x] Deploy accesible por link (quick tunnel — efímero, declarado)
- [x] Borrador guion pitch → `docs/pitch-guion.md`
- [x] Recorrido principal verificado E2E en el link
- [ ] (del lado del usuario) deploy contrato v5 + secrets prod, si se
      quiere settlement real en la demo — sin eso el flujo billing
      funciona pero el settle queda "disabled" honesto
