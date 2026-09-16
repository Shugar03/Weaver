# Competidores-evidencia vs gateways centralizados — snapshot 2026-09-15

> Regla del doc: solo fuentes primarias (sus /pricing, /docs, /terms, /security, /privacy, /legal). Cada cifra lleva URL + fecha de consulta. Lo auto-reportado sin auditoría o citado vía prensa va marcado [débil]. Hechos vs planes/anuncios separados. Lo no verificable va solo en §6, no en el cuerpo.

- Fecha snapshot: 2026-09-15. Moneda: USD salvo indicación.
- Alcance: OpenRouter (gateway), Together AI, Fireworks AI, fal.ai, Replicate (gateways con cómputo propio). Rivales = gateways centralizados de modelos abiertos, no labs.
- Nota de precios: los catálogos rotan (modelos 2026: DeepSeek V4, Qwen3.x, Kimi K3, GLM-5.x). Llama 3.1 8B / DeepSeek-R1/V3 / Qwen 2.5 aparecen donde el /pricing vigente los lista; si no, se dice explícito.

---

## 1. OpenRouter — modelo de negocio exacto

**Hechos (docs/terms/pricing vigentes):**
- No hay markup por token: "We pass through the pricing of the underlying providers; there is no markup on inference pricing (however we do charge a fee when purchasing credits)" — Fuente: OpenRouter FAQ — https://openrouter.ai/docs/faq — fecha: 2026-09-15.
- Quién fija el precio del token: el provider subyacente; OpenRouter lo replica ("you pay the same rate as you would directly with the provider") — Fuente: OpenRouter FAQ — https://openrouter.ai/docs/faq — fecha: 2026-09-15.
- Fee real: 5,5% (mínimo $0,80) al comprar créditos con tarjeta; 5% con crypto — Fuente: OpenRouter FAQ — https://openrouter.ai/docs/faq — fecha: 2026-09-15.
- Plan Business cobra 8% de platform fee (vs 5,5% pay-as-you-go); Enterprise con descuentos de fee a convenir — Fuente: OpenRouter Pricing — https://openrouter.ai/pricing — fecha: 2026-09-15.
- BYOK: franquicia de $25.000/mes de inferencia a precio de lista sin fee en pay-as-you-go ($200.000 en Enterprise); superado eso, 5% de lo que el mismo modelo+provider costaría en OpenRouter, debitado de créditos — Fuente: OpenRouter FAQ — https://openrouter.ai/docs/faq — fecha: 2026-09-15.
- Créditos: mínimo $5 y máximo $25.000 por transacción; reembolso solo dentro de 24 h (fees no reembolsables, crypto nunca); expiran a 365 días — Fuente: OpenRouter Terms §4 — https://openrouter.ai/terms — fecha: 2026-09-15 (Terms: "Last Updated: August 31, 2026").
- Disponibilidad: "does not guarantee availability of any Model… only on an 'as-available' basis" — Fuente: OpenRouter Terms §5.4 — https://openrouter.ai/terms — fecha: 2026-09-15.
- Routing default: balanceo por precio ponderado (inverso del cuadrado del precio) entre providers estables (sin outages significativos en últimos 30 s), resto como fallback — Fuente: OpenRouter Provider Routing — https://openrouter.ai/docs/guides/routing/provider-selection — fecha: 2026-09-15.
- Sorting explícito por `price` / `throughput` / `latency`; atajos `:floor` (precio) y `:nitro` (throughput); umbrales `preferred_min_throughput` / `preferred_max_latency` con percentiles p50/p75/p90/p99 sobre ventana móvil de 5 min (preferencia, no garantía) — Fuente: OpenRouter Provider Routing — https://openrouter.ai/docs/guides/routing/provider-selection — fecha: 2026-09-15.
- Datos de latencia/uptime publicados: por modelo muestran latencia (time to first token) y throughput por provider; "If you would like to optimize for throughput you can use the `:nitro` variant" — Fuente: OpenRouter FAQ — https://openrouter.ai/docs/faq — fecha: 2026-09-15. [débil: es dato medido mostrado, sin metodología/SLO auditado].
- Status público existe: https://status.openrouter.ai — Fuente: link en footer OpenRouter Pricing/Terms — https://openrouter.ai/pricing — fecha: 2026-09-15. [débil: existencia del status page, no su contenido verificado hoy].
- Zero-retention como routing: parámetro `zdr:true` por request + enforcement por grupo de modelos (Anthropic/OpenAI/Google/xAI/otros) a nivel cuenta y guardrails; lista viva en `https://openrouter.ai/api/v1/endpoints/zdr` — Fuente: OpenRouter ZDR — https://openrouter.ai/docs/guides/features/zdr — fecha: 2026-09-15.
- In-region routing (EU/US, tráfico procesado íntegramente en la región) solo en planes Business/Enterprise vía `eu.openrouter.ai` / `us.openrouter.ai` — Fuente: OpenRouter Sovereign AI — https://openrouter.ai/docs/guides/features/sovereign-ai — fecha: 2026-09-15.
- Logging propio: prompts/completions NO se guardan por default; opt-in "Private Input & Output Logging" (debug, sin uso por OpenRouter) y opt-in "Use of Inputs/Outputs" a cambio de 1% de descuento — Fuente: OpenRouter Data Collection — https://openrouter.ai/docs/guides/privacy/data-collection — fecha: 2026-09-15.
- Metadata siempre retenida (tokens, latencia, modelo, costo) para reporting/ranking — Fuente: OpenRouter ZDR blog — https://openrouter.ai/blog/insights/zero-data-retention/ — fecha: 2026-09-11 (consultado 2026-09-15).

**Planes/anuncios (no hechos de precio):** nada en esta sección: todo lo anterior está en docs vigentes.

---

## 2. Tabla comparativa — precio por 1M tokens + GPU dedicada (snapshot 2026-09-15)

> "—" = el /pricing vigente consultado hoy no lista ese modelo legacy. Los catálogos 2026 ya rotaron a DeepSeek V4 / Qwen3.x / Kimi K3 / GLM-5.x. Precios Standard salvo indicación; cached-input aparte donde aplica.

| Modelo referencia | Together AI (serverless, Standard) | Fireworks AI (serverless, Standard) | Replicate | fal.ai |
|---|---|---|---|---|
| Llama 3.1 8B (in/out por 1M) | $0,14 / $0,14 — vía "Llama 3 8B Instruct Lite" — Fuente: https://www.together.ai/pricing — 2026-09-15 | $0,20 / $0,20 — banda "4B–16B parameters… applies uniformly to input and output" — Fuente: https://docs.fireworks.ai/serverless/pricing — 2026-09-15 | — (el /pricing vigente no publica tarifa por-token de Llama 3.1 8B; featured LLM es DeepSeek-R1) — Fuente: https://replicate.com/pricing — 2026-09-15 | N/A — /pricing sin LLMs por token (solo media + GPU) — Fuente: https://fal.ai/pricing — 2026-09-15 |
| DeepSeek (in/out por 1M) | V4 Flash 0731: $0,14 / $0,28 (cached $0,03); V4 Pro 0813: $1,32 / $3,96 — R1/V3 ya no listados — Fuente: https://www.together.ai/pricing — 2026-09-15 | V4 Flash 0731: $0,22 / $0,007 cached / $0,66; V4 Pro 0813: $1,32 / $0,044 cached / $3,96 — R1/V3 ya no listados — Fuente: https://docs.fireworks.ai/serverless/pricing — 2026-09-15 | R1: $3,75 por 1M input + $0,01 por 1K output (= $10 por 1M out) — Fuente: https://replicate.com/pricing — 2026-09-15 | N/A (ídem) — Fuente: https://fal.ai/pricing — 2026-09-15 |
| Qwen (in/out por 1M) | Qwen2.5 7B Instruct Turbo: $0,30 / $0,30; Qwen3.5 9B: $0,17 / $0,25; Qwen3 235B A22B 2507 FP8: $0,20 / $0,60 — Fuente: https://www.together.ai/pricing — 2026-09-15 | Sin Qwen2.5/3 chico listado nominal hoy → banda por tamaño (4–16B: $0,20; >16B: $0,90; MoE 56,1–176B: $1,20) salvo modelos headline — Fuente: https://docs.fireworks.ai/serverless/pricing — 2026-09-15 | — (sin tarifa Qwen por-token en /pricing vigente) — Fuente: https://replicate.com/pricing — 2026-09-15 | N/A (ídem) — Fuente: https://fal.ai/pricing — 2026-09-15 |
| GPU dedicada ($/hr, 1×GPU) | H100 HGX: $5,49 on-demand; promo $3,99 válida hasta 30/09/26; H200: contactar ventas — Fuente: https://www.together.ai/pricing — 2026-09-15 | On-demand desde 01/09: H100 $8,00; H200 $8,00; B200 $13,00; B300 $15,00; GB300 $20,00 (pago por GPU-segundo, sin cargo de arranque) — Fuente: https://fireworks.ai/pricing — 2026-09-15 | H100 $5,49; H200 $5,49 (con committed spend); T4 $0,81; A100 80GB $5,04; L40S $3,51 (privados/despliegues pagan setup+idle+activo; públicos solo activo) — Fuente: https://replicate.com/pricing — 2026-09-15 | H100 lista $4,50 / desde $1,89; H200 $4,50 / desde $2,10; B200 $6,25 / desde $3,49; B300 $8,50 / desde $4,49 — Fuente: https://fal.ai/pricing — 2026-09-15 |

- Batch con descuento: Together Batch API y Fireworks batch al 50% del serverless — Fuentes: https://www.together.ai/pricing y https://docs.fireworks.ai/serverless/pricing — 2026-09-15.
- Replicate cobra doble modelo: GPU-segundo (mayoría) o por output en "official models" — Fuente: https://replicate.com/pricing — 2026-09-15.
- fal.ai es media-first (video/imagen por segundo o por imagen/MP): p. ej. Veo 3 $0,4/s, Flux Kontext Pro $0,04/imagen — Fuente: https://fal.ai/pricing — 2026-09-15.

---

## 3. El "plan Go" + comparables de suscripción

- El "plan Go" de agentes de código SÍ existe y es de **OpenCode**: "OpenCode Go is a low cost $10/month subscription that gives you reliable access to popular open coding models" — Fuente: https://opencode.ai/docs/go/ — fecha: 2026-09-15 (visto 2026-09-14T21:59:46Z).
- Qué incluye: solo modelos abiertos de código (GLM-5.x, Kimi K3/K2.6/K2.7-Code, Qwen3.x, DeepSeek V4, MiniMax M3/M2.7, MiMo V2.5, Muse Spark Contributor, LongCat-2.0, Hy3…) + cerrados GPT 5.6 Luna y Grok acotados; se usa con cualquier agente vía Zen API key (`/connect` → OpenCode Go) — Fuente: https://opencode.ai/docs/go/ — 2026-09-15.
- Límites: medidos en dólares a tarifa por-token publicada — $12/5 h rodantes, $30/semana, $60/mes totales; por modelo: premium (Kimi K3, Qwen3.8 Max, DeepSeek V4 Pro, Grok, GPT 5.6 Luna…) $15/mes c/u; estándar (Kimi K2.7, Qwen3.7 Plus, MiniMax M3, MiMo V2.5…) $60/mes; DeepSeek V4 Flash $30/mes; excedido cae a modelos free o a saldo Zen si se habilita — Fuente: https://opencode.ai/docs/go/ — 2026-09-15.
- Ambigüedad real: "Go" también es un tier de **ChatGPT** (Free/Go/Plus/Pro) en la misma fecha — no confundir con OpenCode Go — Fuente: https://openai.com/chatgpt/pricing/ — 2026-09-15.
- Comparable ChatGPT (estructura verificada, precios NO extraíbles del HTML primario hoy — van a §6): tiers Free / Go / Plus / Pro; Pro = "5x more usage" vs Plus, Codex máximo, deep research máximo — Fuente: https://openai.com/chatgpt/pricing/ — 2026-09-15.
- Comparable Claude (precios/límites NO verificables en primaria hoy — van a §6): la página https://claude.ai/pricing no expuso cifras al fetch del 2026-09-15 (shell JS sin números).

---

## 4. Data retention por gateway (default + zero-retention)

- **OpenRouter** default propio: prompts/completions no se guardan salvo opt-in (logging privado para debug; uso para mejora = 1% descuento); metadata sí — Fuente: https://openrouter.ai/docs/guides/privacy/data-collection — 2026-09-15.
- **OpenRouter** zero-retention: existe como enforcement de routing (`zdr:true`, cuenta, guardrails, 5 grupos de modelos), gratis a nivel routing; lo que cuesta es la residencia regional (Business/Enterprise) — Fuentes: https://openrouter.ai/docs/guides/features/zdr + https://openrouter.ai/docs/guides/features/sovereign-ai — 2026-09-15.
- **OpenRouter** matiz: ZDR ≠ no-entrenamiento ≠ residencia; cada endpoint tiene su política, lo no confirmable se marca como retiene+entrena; plugins/tools y response-caching van por políticas propias — Fuente: https://openrouter.ai/blog/insights/zero-data-retention/ — 2026-09-11.
- **Together AI** default: "does not store inputs or outputs by default, i.e. it supports zero data retention (ZDR)"; training opt-in apagado por default — Fuente: https://docs.together.ai/docs/privacy-and-security — 2026-09-15.
- **Together AI** zero-retention: toggle "No" a store-prompts/train = ZDR, sin costo publicado diferencial; passthrough a terceros con toggle separado — Fuente: https://docs.together.ai/docs/privacy-and-security — 2026-09-15.
- **Together AI** legal: "will not use your data and outputs to train models…" bajo ZDR — Fuente: https://www.together.ai/terms-of-service — 2026-09-15.
- **Fireworks AI** default: "Zero Data Retention by default… does not log or store prompt or generation data for any open models, without explicit user opt-in" (solo memoria volátil; KV-cache minutos si hay prompt caching) — Fuente: https://docs.fireworks.ai/guides/security_compliance/data_handling — 2026-09-15.
- **Fireworks AI** zero-retention: sin costo diferencial publicado; excepción: Response API con `store=True` (default) retiene 30 días, opt-out con `store=False`, borrado inmediato por API — Fuente: https://docs.fireworks.ai/guides/security_compliance/data_handling — 2026-09-15.
- **Fireworks AI** training: "your training data is never used to train Fireworks-owned or shared models"; checkpoints/traces 30 días borrables — Fuente: https://docs.fireworks.ai/fine-tuning/secure-fine-tuning — 2026-09-15.
- **Replicate** default API: inputs+outputs+logs+archivos auto-borrados a la hora; web: retenido indefinidamente salvo borrado manual — Fuente: https://replicate.com/docs/topics/predictions/data-retention — 2026-09-15.
- **Replicate** zero-retention: no existe producto "ZDR" nombrado; el borrado a 1 h es el default gratuito del API — Fuente: https://replicate.com/docs/topics/predictions/data-retention — 2026-09-15.
- **Replicate** entrenamiento: Terms permite "collect and analyze Resultant Data… to improve and enhance the Services" y licencia amplia sobre Customer Data — Fuente: https://replicate.com/terms — 2026-09-15 (consultado; sin carve-out de no-entrenamiento verificado hoy — ver §6).
- **fal.ai** default: payloads JSON 30 días; media en CDN configurable; storage persistente `/data` para siempre (manual) — Fuente: https://fal.ai/docs/documentation/model-apis/media-expiration — 2026-09-15.
- **fal.ai** zero-retention: opt-out gratuito por request (`X-Fal-Store-IO: 0` evita guardar payloads; CDN se controla con `X-Fal-Object-Lifecycle-Preference`); cuenta inactiva 2 años / cierre 30 días — Fuentes: https://fal.ai/docs/documentation/model-apis/media-expiration + https://fal.ai/legal/privacy-policy (2026-07-22) — 2026-09-15.
- **fal.ai** entrenamiento: "Company will not use Client Content to create, train, develop… Company's products or services", excepto modelos "Pending Enterprise Ready" — Fuente: https://fal.ai/legal/api-services — 2026-09-15.

---

## 5. ¿SLOs de latencia (TTFT/p95) o routing por costo medido?

- **OpenRouter** publica latencia (TTFT) y throughput medidos por provider y modelo, y rutea por ellos (`sort: latency/throughput`, `preferred_max_latency`, `preferred_min_throughput` p50–p99 en ventana de 5 min) — pero son *preferencias*, no SLO: "do *not* guarantee you will get a provider or model with this performance level" — Fuente: https://openrouter.ai/docs/guides/routing/provider-selection — 2026-09-15.
- **OpenRouter** no promete SLO contractual público en docs: disponibilidad "as-available" (Terms §5.4); SLAs contractuales solo Enterprise ("Contractual SLAs" en tabla) — Fuentes: https://openrouter.ai/terms + https://openrouter.ai/pricing — 2026-09-15.
- **Together AI** serverless: best-effort con rate limits dinámicos, sin SLA numérico público; Provisioned Throughput (PTU $0,05/min) sí: throughput comprometido + 99% de requests exitosas/mes — Fuente: https://docs.together.ai/docs/inference/provisioned-throughput — 2026-09-15.
- **Together AI** usa TTFT/latencia/p95 como *métrica de autoescalado* en dedicados (`--scaling-metric ttft|e2e_latency`, percentil default p95), no como SLO prometido al cliente — Fuente: https://docs.together.ai/docs/dedicated-endpoints/scaling — 2026-09-15.
- **Fireworks AI** serverless: "no latency or availability guarantees… does not currently come with SLAs" — Fuente: https://docs.fireworks.ai/faq/deployment/serverless/service-levels — 2026-09-15.
- **Fireworks AI** 99,9% cubre solo "503 Service Unavailable" genuino, NO el shed 503 por saturación del fleet compartido; Priority (~1,5× precio) reduce rechazos, no reserva GPUs — Fuente: https://fireworks.ai/blog/serverless-2 — 2026-05-26.
- **Fireworks AI** expone histogramas TTFT/latencia por despliegue propio (observabilidad Prometheus), no promesa pública — Fuente: https://docs.fireworks.ai/deployments/exporting-metrics — 2026-09-15.
- **Replicate**: "Performance SLAs" solo como oferta Enterprise a convenir, sin números públicos — Fuente: https://replicate.com/pricing — 2026-09-15.
- **fal.ai**: sin SLO/TTFT público verificado hoy — ver §6.
- Conclusión para Weaver: nadie promete públicamente routing por ETR (RTT+cola+carga+prefill+gen+verify) ni SLO de TTFT/p95 en serverless; todos miden latencia/throughput y rutean por precio o preferencia de performance, y reservan las garantías duras para capacidad contratada (PTU / Reserved / Enterprise). El ETR medido como métrica única de routing sigue sin clon público verificable al 2026-09-15.

---

## 6. No-verificados (buscados, sin primaria válida al 2026-09-15 — NO citar en cámara)

- Precio $/mes de ChatGPT Go/Plus/Pro y límites numéricos: la página primaria https://openai.com/chatgpt/pricing/ expone tiers y "5x more usage" de Pro pero sin cifras $ extraíbles al fetch del 2026-09-15.
- Precio $/mes y límites de planes Claude (Pro/Max): https://claude.ai/pricing devolvió shell sin cifras extraíbles el 2026-09-15.
- Tarifa por-token de Llama 3.1 8B en Replicate: https://replicate.com/pricing (2026-09-15) no la lista; solo DeepSeek-R1 como LLM featured + GPU-segundo.
- Tarifas por-token de Qwen 2.5/3 y DeepSeek-R1/V3 en Fireworks vigente: rotaron a V4/Qwen3.x headline; R1/V3/Qwen2.5-Chico no listados el 2026-09-15.
- DeepSeek-R1/V3 y Llama 3.1 8B nominal en Together vigente: solo proxies cercanos (Llama 3 8B Lite, V4 Flash); R1/V3 no listados el 2026-09-15.
- LLMs por token en fal.ai: sin evidencia de oferta (su /pricing es media+GPU); no se afirma ni se niega catálogo LLM fuera de /pricing.
- Carve-out explícito anti-entrenamiento de Replicate para prompts de inferencia: sus Terms permiten Resultant Data para mejora; no se halló cláusula "never trains" equivalente a Together/Fireworks en primaria hoy.
- SLO/TTFT/p95 públicos de fal.ai y números de uptime históricos de status pages (status.openrouter.ai existe pero no se auditó contenido hoy).
- Porcentajes de fee BYOK antiguos en prensa ("1M requests gratis"): la doc vigente manda ($25k/$200k list-price + 5%) — cualquier cita vieja va [débil]/obsoleta.

---

## Top 6 citables contra gateways (duros, con fuente y fecha)

1. OpenRouter no marca el token pero cobra 5,5% (mín. $0,80) por cargar créditos y 8% en plan Business — el peaje es la recarga, no el modelo (openrouter.ai/docs/faq + /pricing, 2026-09-15).
2. OpenRouter vende disponibilidad "as-available" sin garantía (Terms §5.4, actualizado 2026-08-31) mientras agrega tu billing en un solo lugar — conveniencia sin SLA público.
3. Fireworks admite por escrito cero garantías de latencia/disponibilidad en serverless (docs/faq/service-levels, 2026-09-15) — su 99,9% solo cubre 503 genuino, no la saturación del fleet (blog Serverless 2.0, 2026-05-26).
4. Together reserva el SLA (99% éxito + throughput) para PTU contratado ($0,05/PTU/min); el serverless es best-effort (docs provisioned-throughput, 2026-09-15) — la garantía se compra aparte.
5. Replicate cobra H100 a $5,49/h y en privados/despliegues factura setup+idle+activo, no solo lo que generás (replicate.com/pricing, 2026-09-15) — pagás la espera del centralizado.
6. OpenCode Go demuestra el techo del peajeussy: $10/mes por hasta $60 de uso en modelos abiertos con caps por modelo de $15 (Kimi K3, Qwen3.8 Max, DeepSeek V4 Pro) (opencode.ai/docs/go, 2026-09-15) — suscripción que raciona lo abierto.
