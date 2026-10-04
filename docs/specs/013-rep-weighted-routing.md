# spec 013 — Reputation-weighted routing (ERC-8004 → scheduler)

## Problema

El routing es ETR puro: la reputación on-chain (attestations ERC-8004 por
jobSettled) existe pero no decide nada. Track 04 pide que la confianza medida
influya en quién computa — sin que deje de ser ETR-first (la velocidad medida
sigue siendo la señal dominante).

## Modelo

`reputationScore(worker) ∈ [0,1]` — Laplace-smoothed sobre las attestations
NO revocadas de todos los agentes del worker:

```
score = (posMass + 1) / (posMass + negMass + 2)
```

- Sin feedback → 0.5 (neutral, ni premio ni castigo — no se inventa reputación)
- Solo positivos, pocos → ~0.8; con masa → → 1.0
- Revocadas no cuentan (la attestación retirada no vale)

`IndexerStore.reputationScores()` devuelve `Map<workerLc, score>` en UNA query
(Feedback ⋈ Agent por agentId; `Agent.owner` = worker pubkey).

## Peso en el ETR — acotado, honesto

```
effectiveEtr = etrMs × (1 + w·(0.5 − rep))
```

- w = 0.3 (env `REP_WEIGHT`, default 0.3): factor ∈ [0.85, 1.15] — la rep
  desempata y gana marginales; jamás pone un forge lento encima de uno muy
  rápido (eso sería routing por política, no por medida)
- rep desconocida (0.5) → ×1.0 — el forgo sin identidad on-chain compite
  neutral, no castigado
- `EtrScheduler.select` y el `order` de RoutedExec usan el MISMO factor
  (la decisión mostrada = la dispatchada)
- `Decision.etrMs` reporta el ETR real (calibración honesta); `reason` lleva
  `|rep-boost` cuando la rep cambió al ganador

## Wiring

- `ForgeView.reputationScore?: number` — lo llena serve desde un cache
  (`workerLc → score`) refrescado del indexer cada 60s + al boot. Sin
  indexer → cache vacío → todo neutral → comportamiento idéntico a hoy.
- `deps.repWeight` (serve: env `REP_WEIGHT`, default 0.3).

## Edge cases

- Forge embedded (sin forgePubkey) → neutral
- Indexer caído en el refresh → cache stale (último score conocido), nunca
  crash — el routing no puede depender de envio para funcionar
- etrMs = ∞ → efectivo ∞ (muerto sigue muerto, la rep no resucita)
