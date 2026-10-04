# spec 012 — Delegation session spend (MetaMask ERC-7710/7715)

## Problema

El usuario paga por inferencia con credits del ledger, pero fondear exige un
depósito on-chain por adelantado. MetaMask Delegation Framework permite algo
mejor: el usuario firma UNA delegación acotada (cap USDC + expiry + targets)
y el agente Weaver gasta contra ella sin popup por request.

Hoy `packages/settlement/src/delegation.ts` ya implementa el espejo off-chain
de los enforcers canónicos v1.3.0 (DelegationManager `0xdb9B…` en Monad). Lo
que falta es la superficie de producto: firmar → canjear → gastar.

## Modelo — mint-on-redeem

Canjear una delegación válida = ejecutar su único "redeem": el gateway valida
la firma EIP-712 y las caveats con el `DelegationEngine` (misma semántica que
`DelegationManager.redeemDelegations` on-chain) y acredita el cap completo al
ledger como topup `dlg:<delegationHash>`.

- **Honesto**: la delegación firmada es un claim real — el agente (delegate =
  operator `SETTLEMENT_SECRET`) podría ejecutarla on-chain en cualquier
  momento dentro de su ventana. Acreditar el cap materializa ese claim.
- **Dedup**: `dlg:<hash>` es ref del topup → replay devuelve 409, jamás doble
  acredita. El hash también es PK en `delegations`.
- **Granular**: calls-limit, methods y targets se verifican contra una
  ejecución sintética `transfer(agent, maxAmount)` sobre el USDC — exactamente
  lo que ejecutaría el redeem on-chain.
- v2 (no en scope): pull lazy por debit + revoke on-chain.

## Caveats exigidos por Weaver

| Enforcer | Requisito |
|---|---|
| ERC20TransferAmount | OBLIGATORIO — define el cap a acreditar (USDC 6dec → stroops ×10) |
| Timestamp | OBLIGATORIO con `before > 0` — delegaciones sin expiry se rechazan |
| AllowedTargets | opcional; si está, debe incluir el token USDC (el engine lo exige) |
| AllowedMethods / LimitedCalls | opcionales; si están, se verifican contra la ejecución sintética |

## API

```
POST /v1/me/delegations/template   { capUSDC: number, ttlSec: number }
  → 200 { domain, types, primaryType, message }   // listo para eth_signTypedData_v4
  → 422 sin wallet linkeada | cap/ttl inválidos

POST /v1/me/delegations            { delegation: Delegation & { signature } }
  → 201 { delegationHash, amountUSDC, credited: true }
  → 401 firma inválida | 403 delegator ≠ wallet de la cuenta
  → 409 ya canjeada | 422 caveat violada (engine error code)

GET  /v1/me/delegations
  → 200 { delegations: [{ hash, delegator, delegate, amountUSDC,
                          expiresAt, createdAt }] }
```

Todas bajo `requireAccount`. `delegate` debe ser `deps.delegationAgent`
(address del operador EVM); el USDC es `deps.usdcToken`.

## Storage

Tabla `delegations` (migration 0011) + `DelegationGrants` store
(pg|mem) en `@weaver/accounts` — el grant se guarda como JSON opaco (el paquete
no depende de settlement).

## UI

Tab DELEGATE en `/account`: form cap+TTL → template → MetaMask
`eth_signTypedData_v4` → redeem → lista de grants. Sin MetaMask → empty state
honesto. La cuenta debe tener wallet linkeada (el delegator ES esa wallet).
