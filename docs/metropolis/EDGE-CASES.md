# Weaver — Catálogo y Matriz de Edge Cases

> Matriz exhaustiva de casos de borde y condiciones extremas para Weaver (Gateway, Scheduler, Forges remotos, Cuentas/Watcher y Contratos EVM/Soroban).
> Diseñado bajo la metodología **SDD (Spec-Driven Development)** y verificado mediante **TDD (Test-Driven Development)**.

---

## 1. Resumen de Cobertura y Métricas

| Prioridad | Área de Impacto | Total Casos | Cubiertos Previo | Nuevos Tests (P0/P1) | Estado |
|---|---|:---:|:---:|:---:|:---:|
| **P0** | **Plata, Fondos y Seguridad Criptográfica** | 8 | 3 | 5 | ✅ Verificado |
| **P1** | **Resiliencia, Failover y Concurrencia** | 8 | 4 | 4 | ✅ Verificado |
| **P2** | **Sanitización de Inputs y Casos Límites** | 5 | 2 | 3 | ✅ Verificado |
| **Total** | | **21** | **9** | **12** | **100% Auditado** |

---

## 2. Matriz Detallada de Edge Cases

### P0 — Plata, Fondos y Seguridad Criptográfica

| ID | Módulo | Escenario de Borde | Invariante y Resultado Esperado | Test / Verificación | Estado |
|---|---|---|---|---|:---:|
| **E01** | `contracts/weaver-escrow-evm` | Intento de `release` después de un `refund` exitoso. | **Revert con `BadState`**. Una vez reembolsado al cliente por expiración de ventana de 24h, el worker no puede cobrar. | `WeaverEscrow.t.sol::test_release_post_refund_falla` | ✅ Verificado |
| **E02** | `contracts/weaver-escrow-evm` | Intento de `refund` después de un `release` exitoso. | **Revert con `BadState`**. Una vez liberado el pago en USDC al worker con proof verificado, el cliente no puede reclamar reembolso. | `WeaverEscrow.t.sol::test_refund_post_release_falla` | ✅ Verificado |
| **E03** | `contracts/weaver-escrow-evm` | `fundJob` con `amount == 0` o worker no registrado (`address(0)`). | **Revert temprano**. `amount == 0` dispara `BadAmount()`; worker inexistente o `address(0)` dispara `ForgeNotFound()`. Sin almacenamiento corrupto. | `WeaverEscrow.t.sol::test_fund_amount_cero_falla` | ✅ Verificado |
| **E04** | `packages/accounts` (EvmWatcher) | Log de evento `Deposited` marcado con `removed: true` (reorg de cadena). | **Descarte inmediato sin acreditar**. Si el nodo RPC emite un log huérfano por reordenamiento de bloques, el watcher no debe acreditar saldo fantasma. | `evmwatcher.test.ts::descarte de logs con removed: true` | ✅ Verificado |
| **E05** | `packages/forge-net` (Session / Remote) | Forge malicioso o desalineado envía frames (`job.chunk`/`job.done`) con `jobId` ajeno. | **Descarte silencioso**. El listener filtra estrictamente por `m.jobId === req.jobId`. Los chunks con ID ajeno no contaminan el stream de otro usuario. | `remote.test.ts::chunks con jobId ajeno son ignorados` | ✅ Verificado |
| **E06** | `apps/gateway` (Paywall) | Replay de header x402 con payload idéntico o expirado. | **Rechazo 402**. El facilitador o el middleware verifica que cada autorización de pago se asiente una sola vez por ejecución. | `paywall.test.ts::replay header x402` | ✅ Verificado |
| **E07** | `apps/gateway` (Billing) | Stream abortado abruptamente por el cliente a mitad de generación. | **Débito proporcional acotado**. Solo se cobra el uso medido (`genTokens` emitidos) y jamás el estimado total ni cobro duplicado. | `billing.test.ts::abort mid-stream débito medido` | ✅ Verificado |
| **E08** | `contracts/weaver-escrow-evm` | Firma con `s` en el rango alto de la curva secp256k1 (maleabilidad de firma). | **Rechazo OpenZeppelin ECDSA**. La librería `ECDSA.recover` revierte firmas maleables antes de tocar balances. | `WeaverEscrow.t.sol::test_maleabilidad_s_alta` | ✅ Verificado |

---

### P1 — Resiliencia, Failover y Concurrencia

| ID | Módulo | Escenario de Borde | Invariante y Resultado Esperado | Test / Verificación | Estado |
|---|---|---|---|---|:---:|
| **E09** | `packages/scheduler` | Flota con todos los nodos caídos o saturados. | **Excepción descriptiva / fallback sin colgar proceso**. El scheduler no entra en loops infinitos; informa estado sin forges disponibles. | `scheduler.test.ts::flota vacía` | ✅ Verificado |
| **E10** | `packages/scheduler` | Métricas con valores anómalos (`RTT = -1`, `NaN`, `Infinity`). | **Penalización máxima**. El forge se trata como inalcanzable y no gana el ruteo frente a nodos con telemetría válida. | `scheduler.test.ts::métricas inválidas NaN/negativo` | ✅ Verificado |
| **E11** | `packages/forge-exec` (Failover) | Falla del primario seguida inmediatamente por falla del secundario. | **Propagación limpia del error**. El stream emite un evento terminal explícito sin dejar sockets en estado zombie ni loops de reintento. | `failover.test.ts::ambos forges caídos` | ✅ Verificado |
| **E12** | `packages/forge-net` (Session) | Conexión WebSocket abierta que jamás envía handshake `auth`. | **Timeout y desconexión forzada**. Las conexiones no autenticadas son cerradas para evitar agotamiento de descriptores de archivo. | `session.test.ts::timeout sin auth` | ✅ Verificado |
| **E13** | `packages/forge-net` (Remote) | Forge envía chunks adicionales después de emitir `job.done`. | **Descarte post-done**. Una vez recibido el proof verificado y cerrado el iterador, cualquier chunk tardío es descartado. | `remote.test.ts::chunks post-done descartados` | ✅ Verificado |
| **E14** | `packages/settlement` (Verifier) | Timeout de red en la llamada al Facilitador x402. | **Fallo seguro (Fail-closed)**. Ante timeout, el verifier retorna `isValid: false` y jamás propaga una excepción no controlada. | `verifier.test.ts::facilitator timeout` | ✅ Verificado |
| **E15** | `packages/accounts` (EvmWatcher) | Bloques vacíos o rango de bloques en la frontera exacta de paginación. | **Avance de cursor determinista**. El cursor no retrocede ni se saltea bloques en límites de lotes de 100 bloques. | `evmwatcher.test.ts::frontera de bloques` | ✅ Verificado |
| **E16** | `packages/settlement` (Queue) | Encolamiento de múltiples liquidaciones concurrentes sobre el mismo nonce. | **Ejecución estrictamente serializada**. La cola de settlement procesa una transacción por vez para garantizar orden secuencial de nonces. | `queue.test.ts::tasks concurrentes en serie` | ✅ Verificado |

---

### P2 — Sanitización de Inputs y Casos Límites

| ID | Módulo | Escenario de Borde | Invariante y Resultado Esperado | Test / Verificación | Estado |
|---|---|---|---|---|:---:|
| **E17** | `apps/gateway` (Chat) | Request HTTP con JSON malformado, array de mensajes vacío o prompt de 0 caracteres. | **HTTP 400 Bad Request**. Validación temprana en el límite de confianza antes de invocar scheduler ni forges. | `admission.test.ts::payloads inválidos` | ✅ Verificado |
| **E18** | `packages/forge-exec` (Proof) | Generación que produce salida vacía (`""`) o caracteres Unicode extremos (emojis, normalización NFC/NFD). | **Hash determinista byte a byte**. El `sha256` se calcula sobre los bytes UTF-8 exactos que se transmitieron por el stream. | `proven.test.ts::unicode y salida vacía` | ✅ Verificado |
| **E19** | `packages/accounts` (Pricing) | Modelo no registrado en la tabla de precios. | **Fallback de tarifa base sin crash**. Aplica el precio default por millón de tokens definido en la configuración. | `pricing.test.ts::modelo sin precio fallback` | ✅ Verificado |
| **E20** | `apps/gateway` (Keyauth) | Clave de API con prefijo correcto pero checksum o longitud inválida. | **HTTP 401 Unauthorized inmediato**. Rechazo sin consulta a Postgres ni asignación de recursos. | `keyauth.test.ts::claves malformadas` | ✅ Verificado |
| **E21** | `apps/gateway` (Ratelimit) | Cliente conectando con cabeceras `X-Forwarded-For` múltiples o IPs IPv6 comprimidas. | **Resolución canónica de bucket**. Previene spoofing de IP para eludir los límites de tasa por minuto. | `ratelimit.test.ts::XFF spoofing e IPv6` | ✅ Verificado |

---

## 3. Guía de Ejecución de la Batería

Para ejecutar la verificación completa de esta batería:

```bash
# 1. Tests de Contratos de Liquidación (EVM Foundry)
~/.foundry/bin/forge test --root contracts/weaver-escrow-evm -vv

# 2. Tests de Red y Forges Remotos (forge-net)
cd packages/forge-net && node --test tests/*.test.ts

# 3. Tests de Cuentas y Depósitos (accounts / evmwatcher)
cd packages/accounts && node --test tests/*.test.ts

# 4. Tests de Gateway y Paywall
cd apps/gateway && node --test tests/*.test.ts

# 5. Tests de Liquidación y Proofs
cd packages/settlement && node --test tests/*.test.ts
```
