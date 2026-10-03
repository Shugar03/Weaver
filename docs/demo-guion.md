# Demo Metropolis Track 04 — Guion video 3 min (ES + subs EN)

Historia: **failover en vivo + Monad EVM + ERC-8004**. Un request de inferencia que no se cae aunque mates el worker primario, liquidación sub-segundo con proof criptográfico en Monad testnet, y reputación descentralizada on-chain para el agente ejecutor. Cero slides, 100% código, red y blockchain real.

## Pre-requisitos (checklist grabación)

- [ ] Box fría (sin cargas en background) + Ollama con `OLLAMA_KEEP_ALIVE=30m` (`qwen3:4b` ya descargado).
- [ ] Terminal 1 (Forge remoto): `weaver-forge up --chain evm --contract 0x51acE4858652D942dC7b320870e4CDbc5c989cD6 --model qwen3:4b`
- [ ] Terminal 2 (Gateway): `SETTLE_CHAIN=evm REMOTE_ONLY=1 SETTLEMENT_SECRET=... SETTLEMENT_CONTRACT=0x51acE4858652D942dC7b320870e4CDbc5c989cD6 ERC8004_AGENTS=1 node apps/gateway/src/serve.ts`
- [ ] Terminal 3 (Web UI): `pnpm --filter @weaver/web dev` (puerto 3000, apunta al gateway `:3001`).
- [ ] **1 RUN de calentamiento** en `/network` descartado para asegurar pesos HOT en VRAM (TTFT medido ~0.2s).
- [ ] Viewport 1440×900. Tabs de MonadVision ya abiertas con los hashes canónicos.
- [ ] Browser abierto en `http://localhost:3000/network` (vista en vivo del pipeline FIRE→ROUTE→EXECUTE→SETTLE).

## Beats (tiempos + texto + pantalla)

### 0:00–0:20 — Hook (landing `/`)

> ES: "Este es Weaver: el nuevo datacenter no tiene paredes. Los modelos abiertos ya ganaron, pero para usarlos hoy tenés que pasar por un peaje: gateways centralizados que te obligan a comprar créditos por adelantado, no te dan SLAs y se quedan con tus márgenes. Weaver saca al intermediario: cualquier GPU se conecta sin permiso, compite por latencia, y cada inferencia se liquida al instante en Monad con proof criptográfico."
>
> EN: "This is Weaver: the datacenter without walls. Open-weight models won, but using them today means paying a toll: centralized gateways forcing prepaid credit top-ups, offering zero real SLAs, and pocketing your margins. Weaver removes the middleman: any GPU joins permissionlessly, competes on measured latency, and every inference settles instantly on Monad with cryptographic delivery proof."

Pantalla: Landing `/`, métricas de red viva, headline. Click en `INSPECT NETWORK PIPELINE →` directo a `/network`.

### 0:20–1:00 — RUN vivo en `/network` (FIRE → ROUTE → EXECUTE → SETTLE)

> ES: "Mando un prompt. No elijo servidores ni toco configs: el scheduler mide ETR en tiempo real — RTT de red, cola en GPU y velocidad de decode — y rutea al forge HOT más rápido. Vemos el pipeline completo en stream: FIRE recibe el request, ROUTE selecciona por ETR medido, EXECUTE transmite los tokens vía WebSocket, y SETTLE prepara el claim. Abajo queda registrado: qué worker ejecutó, TTFT y el hash de entrega."
>
> EN: "I submit a prompt. No manual server picking or configs: our scheduler calculates real-time ETR — network RTT, GPU queue depth, and measured decode speed — routing straight to the fastest warm forge. The pipeline streams live: FIRE accepts the request, ROUTE dispatches via measured ETR, EXECUTE streams tokens over WebSocket, and SETTLE primes the settlement claim. Full metadata is logged: worker address, TTFT, and delivery hash."

Pantalla: Prompt en `/network` → RUN → pipeline animado de 4 etapas → stream de tokens fluido → metadata: forge `0x784E0a01c683df116fA5bb5A91180d6Fc06BF5CB`, TTFT medido ~180ms, reason `warm-first-measured`.

### 1:00–1:45 — KILL + Failover en vivo (resiliencia tolerante a fallos)

> ES: "Ahora rompemos la infraestructura a propósito. En computación distribuida los nodos hogareños o mineros se caen: la red no puede caerse. Mato el forge primario en medio del tráfico... y vuelvo a disparar. El gateway detecta la desconexión antes del token 1, re-enruta en caliente al forge standby por circuit breaker, y el usuario recibe su respuesta sin error 500."
>
> EN: "Now we break it on purpose. In distributed computing, residential or edge nodes drop off: the network must not. I kill the primary forge under traffic... and fire another request. The gateway catches the disconnect pre-token, instantly fails over to the standby forge via circuit breaker, and the user receives a clean stream without a single 500 error."

Pantalla: Click en `Kill Primary Forge` (o `Ctrl+C` en terminal del forge primario) → nuevo RUN → el scheduler descarta el nodo caído, rutea al nodo standby en <15ms → respuesta completa → revivir forge.

### 1:45–2:35 — Settle On-Chain en Monad (MonadVision live)

> ES: "Y esto no es simulación: cada inferencia se paga on-chain. El cliente deposita USDC en el contrato WeaverCredits o paga vía x402. Al servir, el forge remoto firma el hash del resultado con su clave secp256k1 en RAM. Nuestro contrato WeaverEscrow en Monad verifica la firma mediante ecrecover antes de liberar los fondos: sin proof firmado por el worker registrado, no hay pago. Sub-segundo, verified en Monad testnet."
>
> EN: "This isn't a simulation: every single inference is settled on-chain. The client deposits USDC into the WeaverCredits contract or pays via x402. Upon serving, the remote forge signs the result hash using its secp256k1 key in RAM. Our WeaverEscrow contract on Monad verifies the signature via ecrecover before releasing funds: without a valid signed proof matching the registered worker, zero payment. Sub-second finality, fully verified on Monad testnet."

Pantalla (tabs ya abiertas en MonadVision, paneo limpio):
- **Contrato WeaverEscrow:** [`0x51acE4858652D942dC7b320870e4CDbc5c989cD6`](https://testnet.monadvision.com/address/0x51acE4858652D942dC7b320870e4CDbc5c989cD6) (Sourcify verificado).
- **Fund Job tx:** [`0xd8393adb1656de6ad4e1b1d4ced739cde91d2d32be3e13983b8cec313ed1e932`](https://testnet.monadvision.com/tx/0xd8393adb1656de6ad4e1b1d4ced739cde91d2d32be3e13983b8cec313ed1e932) — depósito de 0.01 USDC para el job #2.
- **Release tx (Proof L0):** [`0xf06bff167edabf727a8cc5bdd478bc2d39ff7cd9dec1e27fb865ef94c2564b58`](https://testnet.monadvision.com/tx/0xf06bff167edabf727a8cc5bdd478bc2d39ff7cd9dec1e27fb865ef94c2564b58) — evento `Released(jobId=2, resultHash=0x9f9f...)` y transferencia de 0.01 USDC al forge `0x784E0a01c683df116fA5bb5A91180d6Fc06BF5CB`.

### 2:35–2:50 — ERC-8004: Identidad y Reputación de Agente

> ES: "Y para el track de agentes: identidad sin plataformas. Al arrancar, el forge auto-registra su propio agente en el Identity Registry ERC-8004. Cuando se liquida el escrow, el gateway emite feedback on-chain con el hash y las txs como evidencia inmutable. El agente 1991 acumula reputación portable que le pertenece a su wallet, no a Weaver."
>
> EN: "And for the Autonomous Agents track: platform-free identity. On boot, the forge self-registers its own agent on the ERC-8004 Identity Registry. Once escrow settles, the gateway submits on-chain feedback attaching the result hash and settlement txs as immutable evidence. Agent 1991 builds portable reputation owned by its wallet, not by Weaver."

Pantalla:
- **ERC-8004 Identity Registry:** [`0x8004A818BFB912233c491871b3d84c89A494BD9e`](https://testnet.monadvision.com/address/0x8004A818BFB912233c491871b3d84c89A494BD9e)
- **Live Feedback tx (Agent 1991):** [`0xae89a2f0a15ee337dd2d1548fa8a67f1bf56f051581cfe35dbc14911df6303dd`](https://testnet.monadvision.com/tx/0xae89a2f0a15ee337dd2d1548fa8a67f1bf56f051581cfe35dbc14911df6303dd) — evento `NewFeedback(agentId=1991, tag="jobSettled")`.

### 2:50–3:00 — Cierre (`/security` + ZDR + CTA)

> ES: "Por último, Zero Data Retention: tus prompts nunca tocan disco ni entrenan modelos ajenos; viven en RAM del forge y mueren con el socket. La blockchain solo ve atestaciones y plata. El nuevo datacenter no tiene paredes, rinde cuentas en Monad y no te espía. Probá la testnet en GitHub."
>
> EN: "Finally, Zero Data Retention: your prompts never touch disk or train foreign models; they live in forge RAM and vanish when the socket closes. The blockchain only ever sees attestations and settlement. The new datacenter has no walls, settles on Monad, and never spies on you. Try testnet on GitHub."

Pantalla: `/security` (diagrama ZDR de RAM) → banner final con link a GitHub y contratos de Monad testnet.

## Plan B (si el nodo local se satura grabando)

1. Cortá el TTFT en edición si Ollama hace cold load — el stream y los tags de metadata son lo relevante.
2. El failover al simulador o forge standby es instantáneo: ese take es el punto fuerte técnico.
3. Respaldo de captures: tené listos los screenshots de MonadVision con los hashes reales por si hay hipo de conectividad con el RPC de testnet.
4. Usá siempre el prompt de prueba conciso: "Explain why decentralized inference needs cryptographic proof in 2 sentences."

## Post-producción

- Subtítulos en inglés tomados directamente de la pista `EN` de este guion.
- Descripción del video con enlaces canónicos:
  - Repositorio: `https://github.com/Shugar03/Weaver`
  - WeaverEscrow: `https://testnet.monadvision.com/address/0x51acE4858652D942dC7b320870e4CDbc5c989cD6`
  - Live Fund Tx: `https://testnet.monadvision.com/tx/0xd8393adb1656de6ad4e1b1d4ced739cde91d2d32be3e13983b8cec313ed1e932`
  - Live Release Tx: `https://testnet.monadvision.com/tx/0xf06bff167edabf727a8cc5bdd478bc2d39ff7cd9dec1e27fb865ef94c2564b58`
  - Live ERC-8004 Feedback (Agent 1991): `https://testnet.monadvision.com/tx/0xae89a2f0a15ee337dd2d1548fa8a67f1bf56f051581cfe35dbc14911df6303dd`
  - API endpoint: `POST /v1/chat/completions` (OpenAI-compatible)

## Fuentes (backup ante preguntas de jueces)

Evidencia completa y fechada en `docs/demanda-evidencia.md`. Los 5 citables:

1. Google: 9.7T (abr-2024) → 480T (abr-2025) → 3.2Q tokens/mes (may-2026) — Pichai, I/O 2026.
2. OpenAI API: >6B tokens/min + 800M usuarios/semana (Altman, DevDay oct-2025); 8.6T tokens/día (a16z/OpenRouter dic-2025).
3. Datacenters: 485 TWh en 2025 (+17%) → ~950 TWh en 2030; AI-focused x3 — IEA abr-2026.
4. Paradoja de Jevons: GPT-4 $30/$60 por 1M (2023) → GPT-5 $1.25/$10 (2025), 1000x más barato en 3 años a igual MMLU (a16z) — mientras el consumo se dispara.
5. Concentración de infraestructura: Big Three controlan 63% del cloud (Synergy Q2-2025) + capex de hyperscalers de $646B en 2026 (~2% PIB USA, Apollo feb-2026) + colas de interconexión eléctrica en USA con mediana >3 años (LBNL).

## El rival es el peaje (no los labs)

Posicionamiento: competimos con intermediarios como OpenRouter, Together, Fireworks, fal.ai, Replicate y suscripciones como OpenCode Go — no con los laboratorios base. Evidencia en `docs/competidores-evidencia.md`:

1. OpenRouter no marca el token pero cobra 5,5% (mín. $0,80) por cargar créditos, y 8% en Business — el peaje es la recarga y la custodia.
2. OpenRouter vende disponibilidad "as-available" sin garantía legal de servicio (Terms §5.4) — pura conveniencia sin SLA.
3. Fireworks admite cero garantías de latencia ni disponibilidad en serverless; su 99,9% solo cubre el 503 genuino de infraestructura, no la degradación bajo saturación.
4. Together reserva el SLA para capacidad dedicada PTU ($0,05/min); el serverless estándar opera en best-effort.
5. Replicate cobra H100 a $5,49/h y en deployments privados factura setup + idle + tiempo activo — pagás la espera y la capacidad ociosa.
6. OpenCode Go: $10/mes por hasta $60 de uso teórico, pero con límites de $15 por modelo premium — una suscripción que raciona el acceso a modelos abiertos.
