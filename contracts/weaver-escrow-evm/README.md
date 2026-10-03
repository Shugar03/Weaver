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
| WeaverEscrow | [`0x743C4299e79D7A1Bfe3e6491971eF6116988fc2C`](https://testnet.monadvision.com/address/0x743C4299e79D7A1Bfe3e6491971eF6116988fc2C) | `0x570e835d…cebb0` |
| WeaverCredits | [`0xd14957AE85C4FA10fd5AB9f0d17f1cFcE2C0A498`](https://testnet.monadvision.com/address/0xd14957AE85C4FA10fd5AB9f0d17f1cFcE2C0A498) | `0x29737f3a…589c` |

Ambos verificados en Sourcify (`match`). Operador/admin: `0xbaD8…aF3B`.

## Flow live verificado (job #1, 2026-10-03)

| Paso | tx |
|---|---|
| `registerForge` (worker=operador → signer `0x7c41…bebc`) | `0x820a97fc5be9b97a0ddf3b61bd1853828d91d065a7980423d8d370712b41ecb3` |
| `USDC.approve` (10_000) | `0x3bedd6a94f41b8c7dcfd6c065ce8a32ba77e2e78e86d0aad0b64d98247f9e225` |
| `fundJob` (0.01 USDC) | `0xe93b744e71db47240375d21cf3549571d61e7a38c587ccf679c2b5ac902de3a4` |
| `release` — firma del forge sobre `keccak256(resultHash‖jobId)` verificada, evento `Released` + pago | `0xb0cefb64477a89444cb614a28311c24b1aa256c0097f31b92155f836b1b81c9d` |
