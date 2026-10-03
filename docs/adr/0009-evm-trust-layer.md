# ADR 0009 — Capa de confianza EVM: arquitectura implementada y lecciones de integración

Fecha: 2026-10-03 · Estado: implementado / aceptado

## Contexto

El [ADR 0008](0008-settlement-en-monad-evm.md) definió la decisión de adoptar Monad testnet y ERC-8004 para el settlement y la reputación de agentes en el marco del hackathon Metropolis (Track 04).

Al implementar el pipeline completo en código (`contracts/weaver-escrow-evm/`, `packages/settlement`, `packages/accounts`, `packages/forge-net`) y ejecutar el loop E2E en vivo con forges remotos reales (`contracts/weaver-escrow-evm/deployments/testnet.json`), surgieron restricciones operativas, asincronías de streaming y límites de RPC que definieron la arquitectura final. Este ADR registra las decisiones técnicas concretas adoptadas y las lecciones aprendidas durante la integración.

---

## Decisiones de arquitectura y lecciones de integración

### 1. Semántica del Proof L0: `personal_sign(resultHash)` vs `resultHash ‖ jobId`

- **Decisión:** El forge firma únicamente `personal_sign(resultHash)` (32 bytes sha256 del contenido generado) al terminar de transmitir los tokens, antes de que exista cualquier `jobId` on-chain. `WeaverEscrow.release` valida dicha firma contra el signer registrado del worker.
- **Contexto y lección (v1 vs v2):** En el primer deploy de testnet (`0x743C4299e79D7A1Bfe3e6491971eF6116988fc2C`), el contrato exigía que el forge firmara `keccak256(resultHash ‖ jobId)`. Esto causaba una dependencia circular: el forge sirve el stream en tiempo real antes de interactuar con la blockchain. Exigir `jobId` obligaba a un roundtrip de `fundJob` on-chain previo al inicio de la inferencia, arruinando el Time-To-First-Token (TTFT) y agregando latencia a la experiencia de usuario.
- **Solución v2 (`0x51acE4858652D942dC7b320870e4CDbc5c989cD6`):** El forge genera su prueba criptográfica estrictamente en memoria volátil ligada al output servido. El contrato `WeaverEscrow` asocia el `jobId` con el `worker` durante `fundJob`, y `release` valida que `ecrecover(resultHash) == workerSigner`.

### 2. Soberanía del Agente ERC-8004: Self-registration vs Platform-registration

- **Decisión:** Cada forge registra directamente su propio agente en el singleton canónico `IdentityRegistry` (`0x8004A818BFB912233c491871b3d84c89A494BD9e`) durante el arranque (`weaver-forge up --chain evm`). El `agentId` (NFT ERC-721) queda en custodia de la wallet EOA del operador del forge.
- **Alternativa descartada:** Que el gateway cree y mantenga los agentes on-chain en nombre de los forges (platform-registration). Si bien esto ahorraría una tx de setup al minero, introduce custodia artificial y convierte a Weaver en otro intermediario de identidad. La reputación acumulada debe ser un activo portable que pertenezca a la clave privada del nodo.

### 3. Emisión de feedback en ERC-8004: Operator submitter con evidencia inmutable

- **Decisión:** El gateway actúa como evaluador emitiendo `giveFeedback` en el `ReputationRegistry` (`0x8004B663056A597Dffe9eCcC1965A193B7388713`) tras la confirmación de `WeaverEscrow.release`. La llamada incluye como metadata inmutable `{jobId, fundTx, releaseTx, resultHash}` bajo el tag `jobSettled`.
- **Restricción de protocolo:** El contrato canónico de ERC-8004 prohíbe taxativamente el auto-feedback (`msg.sender == agentOwner` revierte). Por ende, el feedback debe originarse en la wallet del operador/consumidor que verificó la entrega y liberó los fondos.

### 4. Handshake WS y Auth dual: Detección por formato de clave pública

- **Decisión:** `ForgeSession` inspecciona el formato de la clave pública del forge durante el handshake WebSocket:
  - Si comienza con `0x` (64 caracteres hex / 20 bytes address): ejecuta verificación secp256k1 mediante `recoverAddress(hashMessage(nonce), signature)`.
  - Si comienza con `G` (Stellar strkey): ejecuta verificación ed25519 contra el nonce emitido.
- **Alternativa descartada:** Requerir flags estáticos de configuración por daemon o puertos dedicados. La detección dinámica por formato permite que gateways sirvan flotas heterogéneas de GPUs en simultáneo sin duplicar procesos de red.

### 5. Ingesta de depósitos: `eth_getLogs` paginado con protección contra reorgs

- **Decisión:** `EvmDepositWatcher` realiza polling de eventos `Deposited(bytes32 account, uint256 amount)` de `WeaverCredits` utilizando ventanas fijas de ≤100 bloques por query, deduplicando por clave compuesta `txHash:logIndex`, e ignorando explícitamente logs con flag `removed: true`.
- **Restricción de infraestructura:** El RPC público de Monad testnet limita la cantidad de bloques consultables en una sola llamada de logs y el uso de WebSockets para `watchEvent` sufre desconexiones silenciosas. La paginación explícita con cursor persistente y descarte de reorgs garantiza que el saldo del usuario se acredite de forma exacta e idempotente.

### 6. Integración x402 v2: Conexión wire canónica sin SDKs pesados

- **Decisión:** `EvmFacilitatorVerifier` procesa los headers `x-payment` decodificando el payload base64 a un objeto EIP-3009 e interactúa directamente vía HTTP POST con los endpoints `/verify` y `/settle` del facilitator oficial de Monad (`https://x402-facilitator.molandak.org`).
- **Contexto:** El facilitator en testnet opera estrictamente sobre el estándar x402 v2 (`network: eip155:10143`). La integración HTTP nativa evita arrastrar dependencias transitivas pesadas e inestables del paquete `@x402/evm`, reduciendo superficie de ataque y simplificando el manejo de reintentos y timeouts.

### 7. Modelo de claves del Forge: EOA unificada con opción de delegación

- **Decisión:** Por defecto, una única clave privada secp256k1 cubre la autenticación WebSocket, la firma de proofs criptográficos y el cobro del escrow (`msg.sender == worker == signer`).
- **Segregación soportada:** Para forges institucionales que deseen mantener sus fondos en cold storage, el contrato `WeaverEscrow` incluye la función `registerForge(address signer)`, permitiendo que una cold wallet registre una hot key secundaria autorizada exclusivamente para firmar inferencias en RAM.

### 8. Recovery de escrows: Journal intent-first + reconciler por eventos

- **Decisión:** `settleJob` persiste el proof (`recordIntent`, keyed por `keccak256(forgeSig)`) **antes** de invocar `fundJob`. Si el journal falla, el settle aborta sin fondear — invariante fail-closed: jamás existe plata on-chain sin proof durable.
- **Post-fund:** `attachJob` liga el `jobId` al intent cuando la tx mina. Un crash en la ventana `fund→attach` deja un `intent` sin `jobId` + un `Funded` on-chain sin liberar.
- **Reconciler** (`reconcileEvmOrphans`, boot + cada 60s): escanea eventos `Funded` del escrow filtrados por `client=operator` (topics indexados, ventanas de ≤100 bloques — misma restricción RPC que §5), lee `getJob(jobId)`, y empareja intents huérfanos con jobs `state=Funded` del mismo worker. El match es exacto porque `release` solo exige `ecrecover(resultHash,sig)==worker.signer` — cualquier proof válido del worker libera su escrow (§1).
- **Casos límite cubiertos:** intents sin `Funded` (fund nunca minó) se descartan con audit trail — nunca se auto-fondea trabajo a destiempo; `Funded` sin ninguna fila journal (pérdida total) se reporta ruidosamente — la recuperación cae al `refund` del operador a las 24h o al self-claim del forge.

---

## Consecuencias y estado del sistema

- **Simplicidad operativa:** El minero de inferencia solo necesita una clave EOA y correr `weaver-forge up --chain evm`.
- **Inmutabilidad:** Todo pago on-chain en `WeaverEscrow` y todo feedback en `ERC-8004` cuenta con trazabilidad criptográfica verificable en explorers de Monad.
- **Rendimiento:** El desacoplamiento de la firma del `jobId` mantiene el streaming de tokens completamente fluido y sin bloqueos de red blockchain durante la generación.
