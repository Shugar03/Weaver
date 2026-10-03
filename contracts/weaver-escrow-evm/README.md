# Weaver EVM Settlement (Monad)

Port EVM del escrow por job de Weaver (`contracts/weaver-escrow`, Soroban → Solidity,
ver ADR-0008). Desplegado en Monad testnet (chain id `10143`).

## Contratos

- **`WeaverEscrow.sol`** — liquidación por job: `fundJob` mueve USDC del cliente al
  escrow ligado a un worker; `release` paga contra proof L0 (firma `personal_sign`
  del forge sobre `keccak256(resultHash ‖ jobId)`, verificada con `ecrecover`
  contra el signer que cada worker registró); `refund` devuelve al cliente tras
  24h sin claim. El worker puede self-claimear sin el operador.
- **`WeaverCredits.sol`** — `deposit(account, amount)` emite `Deposited`
  (reemplaza el memo de Stellar: el gateway indexa el evento y acredita la
  `Account`). `sweep` retira el float al admin.

## Vendored dependencies (atribución)

`lib/` incluye las dependencias como copia vendoreada (pinned):

- `lib/forge-std` — [foundry-rs/forge-std](https://github.com/foundry-rs/forge-std) @ `1eea5ba`
- `lib/openzeppelin-contracts` — [OpenZeppelin Contracts](https://github.com/OpenZeppelin/openzeppelin-contracts) @ `v5.1.0` (`69c8def`)

Vendoreadas para que `forge build`/`forge test` funcionen tras un `git clone`
sin `forge install` ni submódulos.

## Build / Test

```shell
forge build
forge test   # 18 tests
```

## Deploy (Monad testnet)

Requiere `cast wallet import monad-operator --interactive` y testnet MON + USDC.

```shell
export ETH_RPC_URL=https://testnet-rpc.monad.xyz
forge script script/Deploy.s.sol --broadcast --account monad-operator -vvv
```

## Verify (Sourcify / MonadVision)

```shell
forge verify-contract <addr> src/WeaverEscrow.sol:WeaverEscrow \
  --chain 10143 --verifier sourcify \
  --verifier-url https://sourcify-api-monad.blockvision.org \
  --constructor-args $(cast abi-encode "f(address)" 0x534b2f3A21130d7a60830c2Df862319e593943A3)
```

## Direcciones (testnet)

| Contrato | Dirección |
|---|---|
| USDC (Circle) | `0x534b2f3A21130d7a60830c2Df862319e593943A3` |
| WeaverEscrow | _pendiente_ |
| WeaverCredits | _pendiente_ |
