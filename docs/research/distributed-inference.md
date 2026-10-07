# Deep research — Inferencia distribuida entre forges independientes

Fecha: 2026-10-12 · Autor: Devin (deep-research para ADR-0010 nivel 3)
Estado: síntesis completa → alimenta spec `017-pool-forge`

## La pregunta

¿Puede Weaver servir modelos que exceden el VRAM de cualquier GPU individual
(DeepSeek V3-class ~410-460 GB en Q4, 70B-class ~40 GB) repartiendo el cómputo
entre **forges de operadores independientes, sin confianza mutua, por WAN**?

## Corpus revisado (fuentes primarias)

### Papers (arXiv, oficiales)

| Paper | Aporte clave para Weaver |
|---|---|
| **Petals** — *Distributed Inference and Fine-tuning of LLMs Over The Internet* ([arXiv:2312.08361](https://arxiv.org/abs/2312.08361), extensión journal del demo ACL'23; HSE/Yandex + HuggingFace + UW) | El modelo canónico WAN. Pipeline por bloques contiguos, activaciones ~24 KiB/token (OPT-175B), **fault-tolerance por caché dual** (server KV + client activaciones), load balancing descentralizado por latencia medida. BLOOM-176B ≈1 tok/s en Internet de consumo; Llama-2-70B ≥10× más rápido que offloading. Real-world test 2 continentes. |
| **EdgeShard** ([arXiv:2405.14371](https://arxiv.org/abs/2405.14371)) | Programación dinámica para selección conjunta de dispositivos + partición de modelo en hardware heterogéneo. −50% latencia, 2× throughput en testbed real. |
| **EdgePipe** ([arXiv:2110.14895](https://arxiv.org/abs/2110.14895)) | Partición óptima por DP considerando cómputo/memoria/bandwidth heterogéneos. 11.88× speedup con 16 edge devices, sin pérdida de accuracy. |
| **Jupiter** ([arXiv:2504.08242](https://arxiv.org/abs/2504.08242)) | Pipeline edge que **diferencia prefill vs decode**: intra-sequence PP para prefill, outline-based PP + speculative decoding para decode. Hasta 26.1× reducción de latencia E2E. |
| **MDI-LLM** ([arXiv:2505.18164](https://arxiv.org/abs/2505.18164)) | "Recurrent pipeline parallelism" — reduce idle en devices low-power; throughput crece con N dispositivos. |
| **prima.cpp** ([arXiv:2504.08791](https://arxiv.org/abs/2504.08791), ICLR 2026) | **El substrate más relevante**: fork distribuido de llama.cpp para clusters hogareños (WiFi, CPU+GPU heterogéneo, mmap, piped-ring parallelism con prefetch, algoritmo Halda para asignación de capas por heterogeneidad). Llama-3-70B: **674 ms/token en 4 nodos hogareños** vs OOM en llama.cpp. Open source (OpenCPIL/prima.cpp). |
| **MegaScale-Infer** ([arXiv:2504.02263](https://arxiv.org/abs/2504.02263), ByteDance) | Disaggregated expert parallelism + ping-pong microbatch + M2N comms. Referencia datacenter: informa la dirección experto-paralela, no el MVP WAN. |
| **AMoE / AEP** ([arXiv:2505.08944](https://arxiv.org/abs/2505.08944)) | Expert parallelism asíncrono con µ-queuing por capa; 2.7× throughput vs baselines EP síncronos. |
| **EaaS** ([arXiv:2509.17863](https://arxiv.org/abs/2509.17863)) | Expert-as-a-Service: MoE desagregado en servicios stateless, tolerancia a fallos inherente (<2% pérdida bajo fallos). |
| **MixServe** ([arXiv:2601.08800](https://arxiv.org/abs/2601.08800)) | TP-EP híbrido con AR-A2A fusionado; EP escala inter-nodo mejor que TP pero sufre load imbalance. |

### Docs oficiales / código real

| Fuente | Hallazgo |
|---|---|
| [llama.cpp `tools/rpc/README.md`](https://github.com/ggml-org/llama.cpp/blob/master/tools/rpc/README.md) + [multi-gpu.md](https://github.com/ggml-org/llama.cpp/blob/master/docs/multi-gpu.md) | `ggml-rpc-server` expone dispositivos ggml remotos; `--rpc host:port,...` + `--split-mode layer` reparte capas+KV; soporta RDMA si la fabric lo permite. **RPC es por-operación** (serializa ops de tensor), no por frontera de stage. |
| [llama.cpp Discussion #15020](https://github.com/ggml-org/llama.cpp/discussions/15020) | Dato real de usuario: RPC satura un link 1GbE durante prefill y "performance is very poor" — **confirma que RPC no es WAN-viable**: es LAN/fabric. |
| [b4rtaz/distributed-llama](https://github.com/b4rtaz/distributed-llama) | Tensor-parallel root+workers sobre Ethernet (LAN). Modelo propietario de sync, no boundary-activation. |
| [exo labs](https://github.com/exo-explore/exo) | Stage-parallel con auto-discovery para clusters de consumo; prima.cpp lo supera en benchmarks 30B+. |

## Qué dice la literatura — síntesis

### 1. El primitivo correcto para WAN es pipeline-parallel por bloques contiguos

- **Activaciones inter-stage son minúsculas**: hidden_size×2 bytes/token
  (~24 KiB en 176B-class, ~8 KiB en 32B-class). El prefill viaja en chunks —
  bandwidth de consumo alcanza.
- **La latencia es el techo**: cada token cruza N fronteras × RTT. WAN 30-80 ms
  ⇒ 2 stages ≈ 12-25 tok/s; más stages ⇒ menos. Petals logra ~1 tok/s en
  176B (donde el cómputo por token domina el RTT). **Para modelos grandes el
  RTT queda amortizado por el tiempo de cómputo por capa** — ese es el punto:
  cuanto más grande el modelo, menos relativo pesa la red.
- Tensor parallelism (all-reduce por capa) y llama.cpp RPC (op-level) mueren en
  WAN: requieren round-trips *por capa u operación*, no por stage. Confirmado
  experimentalmente (#15020) y por diseño (MixServe: "TP confined to
  intra-node bandwidth; EP scales inter-node better but load-imbalances").

### 2. Fault-tolerance barata existe: caché dual (Petals Algoritmo 1-3)

- El **server** guarda su KV-cache; el **coordinador** guarda las activaciones
  que *envió* a cada stage. Si un stage muere: se reenvía el historial de
  activaciones al reemplazo (O(t) una vez), solo se recomputan los stages
  caídos.
- **Mapeo directo a Weaver**: nuestro `resume.prefix` ya es la versión
  token-level de esto. La generalización es "replay de activaciones al
  reemplazo" en vez de "replay de tokens al re-rutear". Es la misma idea
  de honestidad: el coordinador reconstruye estado verificable.

### 3. Load balancing por medición, no declaración

- Petals: heap de servers por stage ordenados por **latencia medida**; el
  cliente elige la cadena óptima tipo beam-search. EdgeShard/EdgePipe:
  partición por DP considerando cómputo+mem+bw heterogéneos. prima.cpp:
  Halda resuelve la asignación NP-hard modelando CPU+GPU+disk+mem+OS.
- **Mapeo directo**: ETR medido ya es la filosofía del scheduler Weaver.
  ETR_pipeline = Σ(ETR_stage) + RTT_medido entre fronteras. Nuestro heartbeat
  telemetry ya reporta datos reales — extender a "puedo hospedar stage X del
  modelo M con Y ms entre nosotros".

### 4. MoE cambia el juego a favor de la federación

- DeepSeek/Kimi son MoE: 671B-1T totales pero **~37B activos por token**
  (DeepSeek V3). Una vez residentes los pesos, el cómputo por token es de
  clase 37B — alcanzable por GPU de consumo.
- La literatura datacenter (MegaScale-Infer, AMoE, EaaS, MixServe) converge
  en: attention réplica/data-parallel + experts distribuidos, comunicación
  all-to-all minimizada, µ-batching para esconder latencia. En WAN la
  variante viable es **pocas fronteras + expertos co-localizados por stage**
  (cada stage tiene capas completas incl. sus expertos) — i.e., pipeline por
  bloques igual que denso, no expert-parallel puro.

### 5. Privacidad: el costo honesto (Petals §H + ADR-0010)

- Las activaciones intermedias son **parcialmente invertibles** — un stage
  intermedio puede inferir propiedades del prompt. ZDR se mantiene (nada
  persiste) pero la promesa de privacidad se **degrada a "representaciones
  internas, no plaintext"**.
- Mitigaciones de la literatura: opt-in explícito del usuario, clusters por
  jurisdicción, workloads no-sensibles. Weaver lo documenta y lo hace
  **opt-in por request** (`acceptPooled: true`).

### 6. Lo que NO puede prometerse (honestidad de pitch)

- Nadie le gana al fabricante en su propio modelo: DeepSeek API cuesta
  $0.42/MTok output; un pool hogareño de ~20×24GB dará ~1-4 tok/s y más
  caro. **La conveniencia no es precio** — es: modelos que ninguna API sirve
  (fine-tunes gigantes), privacidad verificada por diseño, y cómputo que de
  otro modo no existe.
- llama.cpp RPC sobre WAN funciona pero es lento (op-level round-trips) —
  MVP-viable, no la meta.

## Landscape de substrates (qué computa las capas)

| Substrate | WAN-viable | Esfuerzo de integración | Veredicto |
|---|---|---|---|
| llama.cpp `--rpc` (`--split-mode layer`) | No (op-level RTT; satura 1GbE) | **Cero** — ya verificado (ADR-0010 n2) | **MVP**: pairing Weaver-managed entre operadores; honesto sobre LAN/decent-link |
| prima.cpp (ICLR'26, fork llama.cpp) | Sí (boundary activation + prefetch + Halda) | Medio — engine adapter que spawnea root+workers | **Fase B**: substrate WAN real para boundary pipeline |
| Petals (Python/HF) | Sí | Alto — stack pesado, archs limitadas | Descartado como substrate; su *protocolo* es el diseño a copiar |
| Stage-server propio sobre llama.cpp | Sí | Semanas de C++ | Fase C opcional |
| vLLM + Ray PP | No (LAN fabric) | Medio | Solo para cluster-forge nivel 2 en datacenter |

## Arquitectura propuesta para Weaver

```
                    gateway
                       │ pool.assign {stages:[A,B], boundarySizes}
        ┌──────────────┴───────────────┐
   forge A (coordinator)          forge B (stage worker)
   llama-server --rpc B    ◄────  ggml-rpc-server   [MVP: substrate RPC]
        │  ó stage-engine  ◄────  stage-engine B    [Fase B: boundary pipeline]
   firma proof pool: hash(input)+hash(output)+hash(participants)+sigs
```

- **Forge B (worker)**: daemon en modo `--rpc-worker` — spawnea
  `ggml-rpc-server`, health-check, anuncia `capability:"rpc"` + endpoint en
  heartbeat. No ve prompts: solo tensores (privacidad preservada en el sentido
  fuerte — nunca ve plaintext).
- **Forge A (coordinator)**: recibe `job.assign` extendido con `rpcPeers`;
  su engine spawn añade `--rpc B` al comando llama-server existente
  (OpenAICompatAdapter). Es responsable del proof y del resultado.
- **Trust**: proof incluye lista de participantes (coordinator firma; gateway
  verifica que los workers listados estaban paired). Fase B añade firma
  por-stage (chained attestation del ADR) y replay-audit opcional.
- **Settlement MVP**: escrow paga al coordinator; atribución del worker
  queda on-chain vía ERC-8004 feedback con tag `pool:{jobId}` (la cadena
  registra que B participó). Revenue-share contract = fase B/C.
- **Failover**: si el worker muere → el engine del coordinator crashea →
  gateway detecta → resume en forge nuevo (maquinaria existente). Si el
  coordinator muere → nuevo coordinator necesita re-pairing (fase B:
  activation replay a stages sobrevivientes).

## Fases

- **Fase A (MVP, este sprint)**: `rpc-worker` capability + pairing brokered +
  job.assign con rpcPeers + proof con participants + tests fake→wire-real.
  Substrate: llama.cpp RPC (LAN). Claim honesto: "forges de operadores
  independientes combinan VRAM — la coordinación, confianza y atribución es
  Weaver; la activación viaja por llama.cpp RPC".
- **Fase B**: boundary-activation pipeline (adapter prima.cpp o stage-server
  propio), activation-replay failover, payout splitting on-chain, opt-in
  `acceptPooled` en el request.
- **Fase C**: MoE-aware expert co-location, WAN hardening, audit replay.

## Riesgos / abiertos

- Throughput WAN del substrate RPC: medir real antes de publicitar (spec
  incluye benchmark e2e LAN como gate).
- Consent del worker: el operador B debe opt-in a prestar GPU a pools
  (`--rpc-worker` ya es opt-in; pairing requiere allowlist o reputación mín).
- Seguridad del RPC: llama.cpp advierte "never run rpc-server on an open
  network" — el daemon debe bindear a la IP del peer pair-ado o túnel;
  documentado como limitación MVP.
