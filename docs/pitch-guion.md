# Pitch script — Metropolis Track 04 (Monad + ERC-8004)

> Duración objetivo: ~3 min hablados + demo en vivo.
> Acompaña el deck `docs/pitch/index.html` (11 slides, flechas para navegar).
> Regla: todas las cifras citables están en `docs/demanda-evidencia.md` y
> `docs/competidores-evidencia.md` — nada que no tenga fuente primaria.

---

## Slide 1 — Hook (15s)

> "Esto es Weaver. El nuevo datacenter no tiene paredes.
> Es un mercado de inferencia: cualquier GPU sirve modelos abiertos,
> cada job se verifica criptográficamente, y cada ejecución se liquida
> en Monad con reputación ERC-8004.
> En tres minutos les muestro por qué hace falta — y después lo van a ver correr."

## Slide 2 — La demanda (20s)

> "La inferencia explotó. Google pasó de 9.7 billones a 3.2 *cuatrillones* de
> tokens por mes en 25 meses — lo dijo Sundar Pichai en el I/O de este año.
> OpenAI sirve más de 6 mil millones de tokens por minuto. Y OpenRouter — el
> agregador más grande — hizo 10x en un año. Esto no es hype: es demanda medida."

## Slide 3 — El cuello (20s)

> "Y del otro lado, la capacidad centralizada no alcanza: los hyperscalers van
> a gastar $646B en capex en 2026 — el 2% del PIB de USA — y conectar un
> datacenter nuevo a la red eléctrica tarda entre 3 y 7 años. El 63% del cloud
> está en tres empresas. Cuando la demanda crece 300x y el supply tarda años,
> alguien cobra el desajuste."

## Slide 4 — El peaje (25s)

> "Ese alguien son los gateways. OpenRouter no marca el precio del token, pero
> te cobra 5.5% — 8% si sos business — solo por cargar créditos. Fireworks
> admite por escrito cero garantías de latencia en serverless. Together vende
> la garantía aparte. Replicate te factura setup, idle y activo: pagás la
> espera del centralizado. El rival no son los labs — es el peaje."

## Slide 5 — El supply (20s)

> "Mientras tanto, el cómputo ya existe. El 75% del silicio del planeta está en
> dispositivos de usuarios — hay entre 30 y 50 devices por cada servidor.
> En 2020, Folding@home juntó 2.4 exaflops con PCs donadas: más que las 500
> supercomputadoras más rápidas del mundo juntas. Está instalado, está ocioso."

## Slide 6 — El matiz (25s)

> "Ahora, el matiz honesto: no podés entrenar el próximo GPT sobre WiFi — la
> latencia residencial mata la coordinación. Pero no hace falta. Cada request
> de inferencia es una isla: cero coordinación entre nodos. Es exactamente el
> patrón donde el edge ya ganó. El edge no entrena la frontera — la sirve.
> No falta cómputo: falta el mercado que lo haga confiable."

## Slide 7 — Weaver (20s)

> "Weaver es ese mercado. Los forges aportan GPUs por WebSocket autenticado.
> El gateway rutea cada job al forge más rápido por ETR *medido* — no
> declarado. Y Monad liquida cada ejecución en sub-segundos mediante un escrow
> verificable e indexa reputación bajo ERC-8004.
> Tres piezas: routing por ETR, verificación criptográfica, liquidación instantánea."

## Slide 8 — Cómo usamos Monad y ERC-8004 (25s)

> "La confianza es el problema real en una red descentralizada. La resolvemos
> con criptografía: cada resultado lleva un hash firmado con la clave secp256k1
> del forge en RAM al momento de servirlo. Nuestro contrato WeaverEscrow en Monad
> solo libera USDC si ecrecover valida esa firma — sin proof válido, no hay plata.
> Y tras el release, el gateway emite feedback al Reputation Registry canónico
> de ERC-8004. El agente 1991 acumula reputación portable on-chain que le pertenece
> a su wallet. Cualquiera lo audita en MonadVision."

## Slide 9 — El producto (20s)

> "Para el usuario es una API key OpenAI-compatible o pago directo por x402 gasless.
> Entra en opencode, cursor, hermes o cualquier framework de agentes.
> Pipeline visible en `/network`: FIRE recibe, ROUTE selecciona por latencia real,
> EXECUTE transmite los tokens y SETTLE liquida on-chain. Zero Data Retention:
> los prompts viven en memoria volátil y mueren con el socket."

## Slide 10 — Estado (15s)

> "Y no es un mockup: contratos WeaverEscrow y WeaverCredits verificados en Sourcify
> en Monad testnet, tests unitarios y de integración verdes en Foundry y Node,
> forges remotos por WebSocket con failover en caliente, y un trail E2E real con
> pagos de USDC y feedback ERC-8004 comprobables on-chain. Todo en código abierto."

## Slide 11 — Transición al demo (10s)

> "Todo lo que les conté corre en vivo. Vamos a verlo."

---

## Demo en vivo — recorrido principal (Track 04)

1. **`/network`** — pipeline interactivo en vivo: FIRE → ROUTE → EXECUTE → SETTLE.
2. **Inferencia en stream** — prompt real a modelo abierto (`qwen3:4b`), TTFT medido visible (~180ms).
3. **Failover en vivo** — matar el forge primario bajo tráfico; el scheduler conmuta a standby en <15ms sin interrumpir la respuesta.
4. **On-chain proof en MonadVision (tabs abiertas):**
   - **WeaverEscrow:** [`0x51acE4858652D942dC7b320870e4CDbc5c989cD6`](https://testnet.monadvision.com/address/0x51acE4858652D942dC7b320870e4CDbc5c989cD6)
   - **Fund Job tx:** [`0xd8393adb1656de6ad4e1b1d4ced739cde91d2d32be3e13983b8cec313ed1e932`](https://testnet.monadvision.com/tx/0xd8393adb1656de6ad4e1b1d4ced739cde91d2d32be3e13983b8cec313ed1e932)
   - **Release tx (Proof L0):** [`0xf06bff167edabf727a8cc5bdd478bc2d39ff7cd9dec1e27fb865ef94c2564b58`](https://testnet.monadvision.com/tx/0xf06bff167edabf727a8cc5bdd478bc2d39ff7cd9dec1e27fb865ef94c2564b58)
5. **ERC-8004 Identity & Reputation:**
   - **Identity Registry:** [`0x8004A818BFB912233c491871b3d84c89A494BD9e`](https://testnet.monadvision.com/address/0x8004A818BFB912233c491871b3d84c89A494BD9e)
   - **Feedback tx (Agent 1991):** [`0xae89a2f0a15ee337dd2d1548fa8a67f1bf56f051581cfe35dbc14911df6303dd`](https://testnet.monadvision.com/tx/0xae89a2f0a15ee337dd2d1548fa8a67f1bf56f051581cfe35dbc14911df6303dd)

## Notas de honestidad (qué NO decir)

- No decir que OpenRouter marca el precio del token (cobra fee de recarga).
- No prometer SLA de latencia absoluto (medimos ETR dinámico, no inventamos SLAs).
- No decir "totalmente descentralizado" sin aclarar: el gateway coordina el ruteo; los forges son descentralizados y la reputación es soberana on-chain.
- No inventar transacciones: usar exclusivamente los hashes verificados del deployment.
