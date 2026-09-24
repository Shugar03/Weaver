# Pitch script — Checkpoint 2 (borrador v1)

> Duración objetivo: ~3 min hablados + demo en vivo.
> Acompaña el deck `docs/pitch/index.html` (11 slides, flechas para navegar).
> Regla: todas las cifras citables están en `docs/demanda-evidencia.md` y
> `docs/competidores-evidencia.md` — nada que no tenga fuente primaria.

---

## Slide 1 — Hook (15s)

> "Esto es Weaver. El nuevo datacenter no tiene paredes.
> Es un mercado de inferencia: cualquier GPU sirve modelos abiertos,
> cada job se verifica criptográficamente, y cada token se paga on-chain.
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
> El gateway rutea cada job al forge más barato y rápido *medido* — no
> declarado. Y Stellar liquida cada ejecución en un escrow verificable.
> Tres piezas: routing, verificación, pago."

## Slide 8 — Cómo usamos Stellar (25s)

> "La confianza es el problema real en una red de desconocidos. La resolvemos
> así: cada resultado lleva un hash firmado con la clave ed25519 del forge.
> El contrato Soroban solo libera el pago si esa firma verifica — sin proof
> válido no hay plata. Y el forge tiene una ventana de 24 horas para
> self-claimear aunque el operador desaparezca. Proof de entrega, on-chain.
> Cualquiera lo audita en stellar.expert."

## Slide 9 — El producto (20s)

> "Para el usuario es una API key: `wvr_…`. Entra en opencode, pi, hermes,
> cursor — cualquier cliente OpenAI-compatible. Billing prepago en USDC,
> debit por tokens medidos. Si no tenés crédito, 402 antes de tocar un forge.
> Marketplace público con TTFT y tok/s medidos — lo no medido muestra un
> guion, no un número inventado."

## Slide 10 — Estado (15s)

> "Y no es un mockup: 262 tests verdes, contrato v5 con self-claim y upgrade,
> forges remotos por WebSocket con attestation y failover, y un smoke e2e
> que corre el loop completo con USDC de testnet. Cero prompts guardados."

## Slide 11 — Transición al demo (10s)

> "Todo lo que les conté corre. Vamos a verlo."

---

## Demo en vivo — recorrido principal (rúbrica Foco de Producto)

1. **`/models`** — marketplace live: modelos reales, providers, tok/s medidos
2. **`/models/[id]`** — detalle: capacidades, snippet, CTA a chat
3. **`/account`** — crear cuenta en un click → deposit address + memo
4. **Top-up USDC testnet** (con memo) → watcher acredita → balance visible
5. **`/chat?model=`** — emitir key `wvr_` → stream real → debit medido
6. **`/v1/me/billing`** — ledger: depósito `dep:<opId>` + debit `job:<id>`
7. **(si hay settlement)** — fund/release en stellar.expert

## Notas de honestidad (qué NO decir)

- No decir que OpenRouter marca el precio del token (cobra fee de recarga)
- No prometer SLA de latencia (medimos, no garantizamos)
- No decir "descentralizado" sin aclarar: el gateway es el punto de
  coordinación — forges multi-operador sí; discovery on-chain es roadmap
- No mostrar métricas no medidas como si fueran reales (el "—" es honestidad)
