# Deep research II — Stage-federation WAN (nivel 3 ADR-0010)

Fecha: 2026-10-13 · Autor: Devin
Estado: síntesis completa → alimenta spec `018-stage-federation`
Complementa: `docs/research/distributed-inference.md` (selección de substrates)

## La pregunta

¿Puede Weaver servir UN job repartido entre forges de **operadores distintos
por Internet** (activaciones frontera viajando WAN), con fallos tolerados,
routing por latencia medida, y verificación de cómputo entre desconocidos?

Respuesta corta de la literatura: **sí, está demostrado en producción** —
Petals corrió BLOOM-176B y Llama-3.1-405B en swarms públicos de voluntarios
sobre Internet de consumo. La física: latencia/token ≥ RTT × profundidad de
pipeline ⇒ útil para capacidad y throughput, no para chat snappy en modelos
chicos.

## Corpus nuevo (fuentes primarias)

| Fuente | Aporte clave |
|---|---|
| **Petals** — [arXiv:2312.08361](https://arxiv.org/abs/2312.08361) (NeurIPS 2023, extensión journal del demo ACL'23), §3.2-3.5 + Algoritmos 1-3 | **El protocolo completo a copiar.** Cliente = coordinator: guarda embeddings (<3% pesos) + logits + sampling; servers = stages con bloques contiguos + KV server-side por sesión. |
| **TOPLOC** — [arXiv:2501.16007](https://arxiv.org/abs/2501.16007) (ICML 2025, Prime Intellect; impl. OSS sobre vLLM) | Verificación trustless: LSH de activaciones intermedias (top-k valores+índices → congruencia polinomial). **258 bytes por 32 tokens** (vs 262KB de embeddings crudos), 100% detección de modelo/prompt/precisión adulterada, robusto a nondeterminismo GPU, validación hasta 100× más rápida que la inferencia. |
| **VeriLLM** — [arXiv:2509.24257](https://arxiv.org/abs/2509.24257) | Verificación pública de inferencia descentralizada a ~1% del costo explotando la separación prefill/decode; arquitectura isomorfa inference-verification. |
| **Prime Intellect — Planetary-Scale Inference** (blog + PRIME-IROH/PRIME-VLLM/PRIME-PIPELINE open source) | Pipeline-parallel vLLM diseñado para latencias de Internet público (~100ms). Insight clave: "convertir requerimientos de memoria en requerimientos de cómputo" — usar el idle time inducido por red para cómputo asíncrono. |
| **INTELLECT-2** — [arXiv:2505.07291](https://arxiv.org/abs/2505.07291) | Primer training RL permisionless global (32B): topoc validators verificando rollouts de workers no confiables **en producción**. Prueba que verificación económica funciona en la práctica. |
| **SWARM parallelism** + rebalancing fault-tolerant | Referencia de rebalanceo estocástico bajo churn extremo. |
| **prima.cpp** — [arXiv:2504.08791](https://arxiv.org/abs/2504.08791) (ICLR 2026) | PRP (pipelined-ring) sobre WiFi hogareño; Halda scheduler heterogeneidad-aware; 70B@674ms/token en 4 nodos, 32B+spec-dec a 26 tok/s. Substrate candidato (fork llama.cpp OSS). |

## Petals §3.2-3.5 — los mecanismos exactos que adoptamos

### Dual attention caches (fault tolerance barata)

- **Server-side**: cada stage guarda su KV-cache por sesión (su rango de capas).
- **Client-side** (= coordinator): guarda las activaciones que *envió* a cada
  stage. Si un stage muere → ban + reemplazo por el siguiente en el heap +
  **replay de las activaciones cacheadas** (O(t) datos, UNA vez, solo en el
  stage caído). El resto de la cadena no recomputa.
- Interpolación elegante: 0 fallos = costo de inferencia cacheada normal;
  todos fallan = degenera a recomputo total (óptimo en ese escenario).

### Routing = shortest-path sobre latencia medida

- Heap de candidatos por stage ordenado por **latencia medida** (ping real,
  no declarado).
- `find_best_chain` = shortest path en un grafo donde peso = tiempo de
  cómputo declarado del server + RTT medido cliente↔server; bloques
  consecutivos en un server multiplican su peso.
- **D* Lite** en background: re-pathfinding incremental cuando un server es
  baneado o se va — no re-correr Dijkstra desde cero.
- Load balancing descentralizado: servers anuncian bloques+throughput medido;
  intervalos SIEMPRE contiguos (split de bloques rompe latencia); rebalanceo
  greedy solo si mejora el throughput total.

### Comunicación directa stage→stage + checksum asíncrono

- Forma básica: todo reenvía vía cliente (más simple, +1 hop).
- Optimización Petals: stage i envía sus activaciones **al cliente Y al stage
  i+1 en paralelo**; cliente y stage verifican el mismo checksum/hash
  **asíncronamente sin bloquear cómputo** — consistencia + mínima latencia.

### Cuánto viaja por la red

- Activaciones frontera: `hidden_size × 2 bytes` por token (fp16) — **24 KiB
  en 176B-class, ~8 KiB en 32B-class**. MoE: aún menos por expertos activos.
- §3.5: **dynamic blockwise quantization de hidden states** — mitad del
  bandwidth sin pérdida medible de calidad. Pesos 8-bit (outlier-separado) o
  NF4.
- Prefill viaja en chunks; decode = 1 token por round-trip por frontera.

## Qué mapea a Weaver 1:1 (lo que ya tenemos)

| Petals | Weaver (existente) |
|---|---|
| DHT de servers anunciando bloques+throughput | `Registry` + heartbeat telemetry (ya reporta datos medidos) |
| Heap por latencia medida | ETR medido (filosofía idéntica del scheduler) |
| Leases/atribución de cómputo | `ForgePool` (acquire/release/penalize por jobId) — el 60% del pairing ya existe |
| Cliente-orquestador con embeddings+logits | Un `PipelineExec` en el coordinator — el daemon ya sabe spawnear engines por peer-set |
| Failover con estado verificable | `resume.prefix` token-level → generalizar a "replay de activaciones" |
| Opt-in del usuario a swarm público | `acceptPooled` en el request (ya previsto en spec 017) |

## Lo que es genuinamente nuevo (el protocolo)

1. **`stage-worker` capability**: anuncia `{model, layers:[k..n], vramGb,
   tpsMedido, endpoint}` — un forge que hospeda bloques contiguos, no un
   modelo entero. Distinto de `rpc-worker` (prestador de VRAM opaqu e LAN).
2. **Canal de activaciones**: frames binarios `{sessionId, seq, shape, dtype,
   payload}` — no tokens, no texto. Transporte: **relay vía coordinator en
   MVP** (stage solo habla con coordinator → cero problema NAT para stages
   que no pueden aceptar inbound; los que sí, exponen endpoint). Fase B:
   directo stage→stage con checksum (la optimización Petals).
3. **Sesión con KV**: `stage.open {sessionId, blocks, kvLenHint}` → loop
   `stage.step` (activación in → activación out, KV incremental server-side)
   → `stage.close`. Cada stage es stateful por sesión, stateless entre jobs.
4. **Failover**: ban(stage) + heap siguiente + replay de activaciones
   cacheadas + `chain.replace`. La cadena se reconfigura sin reiniciar el job.
5. **Confianza**: cadena de firmas `sign(hash(act_in)‖hash(act_out)‖jobId)`
   por stage + **TOPLOC commitments** por chunk (258B/32tok — verificable a
   ~1% costo estilo VeriLLM). Replay-sampling del gateway como fallback.

## Decisiones quirúrgicas (evidencia → decisión)

| Pregunta | Evidencia | Decisión |
|---|---|---|
| ¿Pipeline o tensor/expert-parallel? | TP muere en WAN (all-reduce por capa); EP desbalancea en WAN (MixServe) | **Pipeline por bloques contiguos** — cada stage tiene capas completas incl. sus expertos (MoE co-localizado) |
| ¿Coordinación cliente-side o orquestador externo? | Petals §3.2: el cliente orquesta porque guarda caches de replay | **Coordinator-orquestado**: el forge que acepta el job es el "cliente" Petals (embeddings+logits+sampling+caches) |
| ¿Relay o directo stage→stage? | Petals: directo es mejor pero requiere inbound a cada stage (NAT) | **Relay MVP** (stages solo hablan con coordinator), **directo fase B** con checksum async |
| ¿Verificación por replay o por LSH? | TOPLOC: 258B/32tok, 100% detección, robusto a nondeterminismo | **TOPLOC-style commitments fase B**; MVP: firma hash por stage + replay-sampling |
| ¿Substrate de cómputo real? | llama.cpp no expone fronteras de capa ni KV externo; prima.cpp es research-grade | **stage-sim** (protocolo+tensores reales, cómputo stub) para toda la capa Weaver → **`llama.cpp --stage k..n`** (modo stage en nuestro build, ~C++ contenido) para live gate |
| ¿DHT/libp2p para discovery? | Petals usa libp2p+DHT — pesado | **El gateway ES el DHT** — registry existente, heartbeat ya fluye; centralización aceptada (ya es el diseño Weaver) |
| ¿KV en quién? | Petals Algo 2: KV server-side por sesión | **KV en el stage**; coordinator nunca ve KV (solo activaciones) |

## Honestidad física — lo que NO se promete

- Latencia/token ≥ RTT×profundidad ⇒ WAN real: **~5-25 tok/s** según hops.
  Vale para modelos que ningún forge solo corre (>200B) y batch — NO para
  chat snappy ni para competirle a la API del fabricante en su propio modelo.
- Activaciones intermedias **parcialmente invertibles** — la privacidad se
  degrada a "representaciones internas", opt-in explícito.
- Stages deben ser alcanzables **por el coordinator** (endpoint público o
  relay) — NAT traversal (libp2p-style) queda fuera del MVP.
- El coordinator ve el prompt completo (es quien hace embeddings) — el
  trust-anchor sigue siendo el coordinator; stages solo ven tensores.
