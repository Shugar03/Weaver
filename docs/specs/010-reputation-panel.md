# Spec 010 — Reputation surface (ERC-8004 visible)

## Problema

Los forges tienen identidad ERC-8004 verificada on-chain (agentId + ownerOf
check gateway-side) y el indexer ya guarda cada `NewFeedback`. Nada de eso se
ve — la reputación medida on-chain es el diferencial de Track 04 y hoy es
invisible.

## Diseño

```
forge.forgeAgentId + forgeAgentVerified (v1/forges)
        │
        ▼
/v1/network/reputation?agentId=N  (spec 008 — envio Feedback+Agent)
        │
        ├──► RepChip     — en cada fila de /forge: REP {avg} · {count}fb
        └──► ReputationPanel — en la consola del forge: avg, count, y la
             lista de attestations (valor normalizado por decimals, tags,
             cliente, txHash→explorer, revocados marcados)
```

### Honestidad

- Chip/panel SOLO con `forgeAgentVerified` — un agentId claim no verificado
  no es evidencia (el registry lo marca, la UI lo respeta).
- Valor = `value / 10^valueDecimals` tal cual el contrato lo emite — la UI
  no inventa escala de estrellas. Nuestro gateway emite `+1` por jobSettled:
  el count ES la señal ("N attestations on-chain").
- Revocados se muestran tachados con badge — existen en el registro, no se
  borran ni se cuentan en el avg (el endpoint ya los excluye del avg).
- Sin indexer → el panel se oculta (no muestra "0" falso); sin agentId →
  línea honesta "sin identidad on-chain verificada".

## TDD / verificación

1. RepChip: fetch + render `REP {avg} · {count}fb`; count=0 → dim; endpoint
   404 → no renderiza nada.
2. ReputationPanel: lista feedbacks con valor normalizado; revocado marcado;
   txHash linkea a monadvision.
3. Live: live1 (agentId 1991) muestra sus settles reales del indexer.
