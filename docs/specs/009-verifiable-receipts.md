# Spec 009 — Verifiable Execution Receipts

## Problema

El proof L0 (resultHash + firma del forge) existe y gatea el settle, pero es
**invisible**: el cliente que recibió el output no puede verificar que lo que
leyó es lo que el forge firmó y lo que el escrow pagó. Track 04 pide trust
**demostrable** — un receipt que el cliente verifica solo, sin confiar en
nosotros.

## Diseño

```
forge firma ──► proof{resultHash,signature} ──► gateway verifica (S37)
                                              ├─► SSE chunk final: weaver_proof
                                              ├─► response non-stream: weaver_proof
                                              └─► sample persisted (jobId/hash/sig)
cliente ──► sha256(output recibido) == resultHash?
        ──► ecrecover(personal_sign(resultHash)) == signer on-chain?
        ──► releaseTx → explorer (el pago probó el trabajo)
```

### Contratos

- `resultHash` = `sha256(chunks utf8 concatenados tal como se sirvieron)`
  — el wire ya lo enforcea gateway-side (`remote.ts` re-hashea lo relayed).
- `signature` = `personal_sign` del forge sobre los 32 bytes del hash (EVM).
- `signer` = address on-chain del forge (registry ERC-8004 / job.worker).
- `weaver_proof` viaja como campo extra del chunk final / response — shape
  OpenAI intacta, clientes que no lo conocen lo ignoran.
- Persistencia: `performance_samples` + `job_id`/`result_hash`/`proof_sig`
  (migration 0010). `/v1/executions?jobId=` lookup por receipt.

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
