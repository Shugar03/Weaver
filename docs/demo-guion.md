# Demo Checkpoint 1 — guion video 3 min (ES + subs EN)

Historia: **failover + Stellar**. Un chat que sigue andando aunque mates el servidor,
y un pago real en testnet que cualquiera puede verificar. Tesis + plata, nada de slides.

## Pre-requisitos (checklist grabación)

- [ ] Box fría (nada pesado corriendo) + `OLLAMA_KEEP_ALIVE=30m` — bajo carga el TTFT se va a 26–47s.
- [ ] `ollama serve` en terminal 1, modelo `qwen3:4b` ya pulleado.
- [ ] Terminal 2: `node apps/gateway/src/serve.ts` → copiar la **operator key** del log.
- [ ] Terminal 3: `pnpm --filter @weaver/web dev` (puerto 3000). Gateway default `:3001`, la web ya lo espera.
- [ ] **1 RUN de calentamiento** en `/dashboard` y descartarlo (deja pesos HOT, TTFT ~0.2s).
- [ ] Viewport 1440×900. Prompt corto en el textarea (el default largo es para uso, no para cámara).
- [ ] `OPERATOR_KEY=wvr_... node scripts/demo-capture.mjs` verde al menos una vez (deja las 3 tomas en `/tmp`).

## Beats (tiempos + texto + pantalla)

### 0:00–0:20 — Hook (landing `/`)

> ES: "Este es Weaver: el nuevo datacenter no tiene paredes. Los modelos abiertos ya
> ganaron — Google sirve 300 veces más tokens que hace dos años. Pero para usarlos pasás
> por un peaje: los gateways te cobran por cargar créditos, no te garantizan nada y te
> atan a su suscripción. Weaver saca al intermediario: cualquier GPU compite y cada job
> se paga en Stellar, por uso, sin recarga."
>
> EN: "This is Weaver: the new datacenter has no walls. Open models already won — Google
> serves 300x the tokens it did two years ago. But using them means paying a toll:
> gateways charge you to top up credits, guarantee nothing, and lock you into
> subscriptions. Weaver removes the middleman: any GPU competes, and every job pays out
> on Stellar — per use, no top-ups."

Pantalla: hero + arco. Click en `RUN LIVE DEMO →`.

### 0:20–1:00 — RUN vivo (`/dashboard` #live)

> ES: "Pido un modelo. No elijo servidor, no configuro nada: el scheduler mide ETR —
> red, cola, carga — y manda mi job al forge HOT más barato. Responde en stream, y abajo
> dice quién lo ejecutó, en cuánto, y por qué."
>
> EN: "I ask for a model. No server picking, no config: the scheduler scores ETR —
> network, queue, load — and routes my job to the cheapest HOT forge. It streams back,
> and below it says who ran it, how fast, and why."

Pantalla: prompt corto → RUN → stream → meta `FORGE ollama-local TTFT … WHY warm-first`.

### 1:00–1:50 — KILL + failover (el clip que vende)

> ES: "Ahora lo rompo a propósito. Mato el forge primario… y vuelvo a pedir.
> El request sigue andando: hizo failover al standby, en vivo. En cómputo descentralizado
> los nodos se caen — la red, no."
>
> EN: "Now I break it on purpose. I kill the primary forge… and ask again.
> The request still completes: it failed over to standby, live. In decentralized
> compute, nodes fall — the network doesn't."

Pantalla: `Kill Forge` → RUN → `forge-sim-01` en el meta → `Revivir Forge`.

### 1:50–2:40 — Plata real (stellar.expert)

> ES: "Y esto no es teatro: cada job se paga. Escrow en Soroban, testnet de Stellar,
> un centavo de USDC: el cliente fondea, el contrato libera al worker contra resultado.
> Sin fee por recargar, sin créditos que expiran: plata programable, por job.
> Estas transacciones las verifica cualquiera."
>
> EN: "And this isn't theater: every job gets paid. A Soroban escrow on Stellar testnet,
> one cent in USDC: the client funds, the contract releases to the worker on result.
> No top-up fees, no expiring credits: programmable money, per job.
> Anyone can verify these transactions."

Pantalla (pestañas ya abiertas, nada de tipear hashes en cámara):

- fund $0.01: `https://stellar.expert/explorer/testnet/tx/177a7185e3349c0adef305ec856ba6d17d6868171c66388c8d3382b5eb727655`
- release: `https://stellar.expert/explorer/testnet/tx/d6e75fcdb967b56a4dd6cd2218f1e6a12efc636287212ed48bbf1d6b2ff86b3b`
- contrato: `https://stellar.expert/explorer/testnet/contract/CDPOGSQLTLRZPCE2NF4WFVSMGQEGLOAPBM5LFCK2U26LP6B5YVN5GBU3`

### 2:40–3:00 — Cierre (`/security` 5s + CTA)

> ES: "Y lo que ningún explorer muestra: tus prompts. Weaver no los guarda — viven en RAM
> y mueren con el request. La cadena solo ve plata. The new datacenter has no walls —
> y no te espía. Repo y testnet abajo."
>
> EN: "And what no explorer shows: your prompts. Weaver doesn't keep them — they live
> in RAM and die with the request. The chain only ever sees money. The new datacenter
> has no walls — and it doesn't spy on you."

## Plan B (si Ollama se pone lento grabando)

1. Cortá el TTFT en edición — el stream se ve igual. Lo que importa es el meta final.
2. El failover al sim es instantáneo: ese clip te salva el video aunque el take 1 salga lento.
3. Respaldo: `scripts/demo-capture.mjs` deja `/tmp/weaver-take1-run.png` y
   `/tmp/weaver-take3-failover.png` — mostralos como stills con voz encima.
4. Nunca grabes con el prompt default largo ni sin el RUN de calentamiento.

## Post

- Subtítulos EN desde la columna EN de arriba (timings del beat).
- Descripción del video: repo + los 3 links de testnet + `GET /v1/models` para agentes.
- Una línea de fuentes en la descripción: "Demanda: Google I/O 2026 · Energía: IEA abr-2026 · Cloud: Synergy Q2-2025".

## Fuentes (backup ante preguntas de jueces)

Evidencia completa y fechada en `docs/demanda-evidencia.md`. Los 5 citables:

1. Google 9.7T (abr-2024) → 480T (abr-2025) → 3.2Q tokens/mes (may-2026) — Pichai, I/O 2026.
2. OpenAI API >6B tokens/min + 800M usuarios/semana (Altman, DevDay oct-2025); 8.6T tokens/día (a16z/OpenRouter dic-2025).
3. Datacenters 485 TWh en 2025 (+17%) → ~950 TWh en 2030; AI-focused x3 — IEA abr-2026.
4. Jevons: GPT-4 $30/$60 por 1M (2023) → GPT-5 $1.25/$10 (2025), 1000x en 3 años a igual MMLU (a16z) — mientras el volumen vuela.
5. Big Three 63% cloud (Synergy Q2-2025) + capex hyperscalers $646B en 2026 ~2% PIB USA (Apollo feb-2026) + colas de interconexión USA con mediana >3 años (LBNL).

Qué NO decimos en cámara (sin primaria sólida): backlog $ de NVIDIA, lead times exactos H100, revenues auto-reportados de redes DePIN.

## El rival es el peaje (no los labs)

Posicionamiento corregido 15/09: competimos con OpenRouter, Together, Fireworks, fal.ai,
Replicate y suscripciones como OpenCode Go — no con Google. Evidencia en
`docs/competidores-evidencia.md` (snapshot 15/09, solo primarias). Los 6 dardos:

1. OpenRouter no marca el token pero cobra 5,5% (mín. $0,80) por cargar créditos, 8% en Business — el peaje es la recarga.
2. OpenRouter vende disponibilidad "as-available" sin garantía (Terms §5.4) — conveniencia sin SLA.
3. Fireworks admite cero garantías de latencia/disponibilidad en serverless; su 99,9% solo cubre el 503 genuino, no la saturación.
4. Together reserva el SLA para PTU contratado ($0,05/min); el serverless es best-effort.
5. Replicate cobra H100 a $5,49/h y en privados factura setup+idle+activo — pagás la espera.
6. OpenCode Go: $10/mes por hasta $60 de uso, con caps de $15 por modelo premium — suscripción que raciona lo abierto.

Líneas rojas (serían mentira en cámara): decir que OpenRouter marca el token (no lo hace);
vender ZDR como diferencial único (Together y Fireworks ya lo tienen por default);
citar a fal.ai como gateway de LLMs (su pricing es media+GPU).
