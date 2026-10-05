# Spec 009 — Verifiable Execution Receipts

## Problema

El proof L0 (resultHash + firma del forge) existe y gatea el settle, pero es
**invisible**: el cliente que recibió el output no puede verificar que lo que
leyó es lo que el forge firmó y lo que el escrow pagó. Track 04 pide trust
**demostrable** — un receipt que el cliente verifica solo, sin confiar en
nosotros.

## Diseño

```
forge firma ──► proof{resultHash,promptHash,outputHash,signature} ──► gateway verifica (S37)
                                              ├─► SSE chunk final: weaver_proof
                                              ├─► response non-stream: weaver_proof
                                              └─► sample persisted (jobId/hash/sig)
cliente ──► sha256(output leído) == outputHash?
        ──► sha256(input enviado) == promptHash?
        ──► sha256(promptHash‖outputHash) == resultHash?   (commitment)
        ──► ecrecover(personal_sign(resultHash)) == signer on-chain?
        ──► releaseTx → explorer (el pago probó el trabajo)
```

### Contratos

- `promptHash` = `sha256(JSON.stringify({model, messages, resume?}))` — el
  input DESPACHADO (messages verbatim; si no hay array,
  `[{role:"user",content:prompt}]`). `resume` solo en mid-stream resume (ver
  sección siguiente): el commitment ata también "continuó DESDE este prefijo".
- `outputHash` = `sha256(chunks kind!=="think" utf8 concatenados)` — el
  razonamiento efímero no ata (el cliente verifica lo que el usuario leyó).
- `resultHash` = commitment `sha256(promptHash‖outputHash)` — es lo que se
  firma y lo que viaja al contrato en release. Un forge no puede alegar que
  recibió otro prompt: el gateway recomputa el promptHash del input que
  despachó y rechaza el proof si no matchea.
- `signature` = `personal_sign` del forge sobre los 32 bytes del commitment.
- `signer` = address on-chain del forge (registry ERC-8004 / job.worker);
  embedded: pubkey derivada de WORKER_SECRET (dev también verifica e2e).
- `weaver_proof` viaja como campo extra del chunk final / response — shape
  OpenAI intacta, clientes que no lo conocen lo ignoran.
- Legacy: forges sin promptHash firman outputHash directo — gateway y chip
  aceptan ambos contratos.
- Persistencia: `performance_samples` + `job_id`/`result_hash`/`proof_sig`
  (migration 0010). `/v1/executions?jobId=` lookup por receipt.

### Mid-stream resume (S45)

Si el forge muere DESPUÉS de emitir prefijo, el sucesor recibe
`job.assign.resume = {prefix}` (contenido visible ya servido) y continúa
desde ahí — el usuario no pierde el stream. Semántica del proof:

- El forge que COMPLETÓ firma `outputHash = sha256(sufijo propio)` — solo
  firma el trabajo que hizo, no el del muerto.
- `promptHash` incluye `resume` — el commitment ata qué texto continuó.
- El gateway emite un segundo frame `weaver_route` mid-stream con
  `resumedPrefixLen` (chars de prefijo): el cliente hashea
  `output[prefixLen:]` para el outputHash y reconstruye
  `{model, messages, resume: output[:prefixLen]}` para el promptHash.
- El prefijo del forge muerto queda sin firma (murió — nada que firmar);
  se muestra en el badge `RESUMED dead → alive @Nch`, no se esconde.

### Honestidad

- Sin proof (job fallido, forge embedded sin firma) → no hay `weaver_proof`.
  El campo falta, no viaja null/placeholder.
- `signer` ausente si el forge no está en registry — el cliente verifica
  hash-sig pero no puede atar a identidad on-chain (se dice, no se inventa).
- Sample persiste proof SOLO si llegó — no reconstruimos.

## TDD

1. SSE: último data-frame lleva `weaver_proof{jobId,forgeId,resultHash,
   signature}` — resultHash matchea sha256 de los chunks servidos.
2. Non-stream: `weaver_proof` en el response JSON.
3. `/v1/executions?jobId=<id>` devuelve el sample con campos de receipt.
4. PgTelemetry: record+recent roundtrip preserva jobId/hash/sig.
5. Job sin proof (fail) → sample sin campos receipt, SSE sin weaver_proof.

## Fuera de scope

- Verificación ed25519 client-side (fleet demo es EVM — el chip verifica
  EVM, firma Stellar se reporta "not verifiable client-side" honesto).
- On-chain lookup del jobId en escrow (releaseTx ya lo evidencia).
