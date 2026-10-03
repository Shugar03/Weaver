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

## Direcciones (Monad testnet, chain 10143)

| Contrato | Dirección | Deploy tx |
|---|---|---|
| USDC (Circle) | [`0x534b2f3A21130d7a60830c2Df862319e593943A3`](https://testnet.monadvision.com/address/0x534b2f3A21130d7a60830c2Df862319e593943A3) | — |
| WeaverEscrow | [`0x51acE4858652D942dC7b320870e4CDbc5c989cD6`](https://testnet.monadvision.com/address/0x51acE4858652D942dC7b320870e4CDbc5c989cD6) | `0xb6da173e…5150` |
| WeaverCredits | [`0xd14957AE85C4FA10fd5AB9f0d17f1cFcE2C0A498`](https://testnet.monadvision.com/address/0xd14957AE85C4FA10fd5AB9f0d17f1cFcE2C0A498) | `0x29737f3a…589c` |

Verificados en Sourcify (`match`). Operador/admin: `0xbaD8…aF3B`.
(v1 anterior `0x743C…fc2C` — proof ataba `resultHash‖jobId`; corregido a `resultHash`
solo, payload idéntico al escrow Soroban: el forge firma al servir, antes de que
exista el jobId.)

## Flow live verificado (job #1, 2026-10-03)

| Paso | tx |
|---|---|
| `registerForge` (worker=operador → signer `0x7c41…bebc`) | `0x703c12eb6f138cdf6be95f1137df8548f5a3cb8ac5696015a7b02e36ce924fcf` |
| `USDC.approve` (10_000) | `0xe8b521d50d83ac40e076e71fa7f140294b2f265b90b066b9fa08d8e66884924e` |
| `fundJob` (0.01 USDC) | `0x0069b8c83da9d3deff81701577600c4e062b675f6bcad3ea56815d5b702aba90` |
| `release` — firma del forge sobre `resultHash` verificada on-chain, evento `Released` + pago | `0xa5d830a9a08a25afacd3c1d9a949f3f94788a8df48bae40621f2c29a28decdc0` |

## ERC-8004 live (singletons oficiales, 2026-10-03)

| Paso | Resultado |
|---|---|
| Identidad del forge | agentId **1990** — owner `0x7c41…bebc` (el forge se registra a sí mismo) |
| `register()` tx | `0x1d34302d90320139d7df69a8a7e66537bb80915192958f92989eddb07f84268a` |
| `setAgentURI` (registration file data URI on-chain) | `0x127fa32c3b0dc8419727388c1a0d37718c32478791de77f722a3abd48653ef8b` |
| `giveFeedback` del operador sobre job #1 (`tag1=jobSettled`, evidencia = recibo del escrow) | `0x5992e246af0d1d25bb81b85b3626a6bf0593059bb31ead81f85bbb10ee0662bb` |
| `getSummary(1990, [operador], "jobSettled")` | count=1, value=1 ✓ |
