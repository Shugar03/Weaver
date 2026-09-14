# Referencias roadmap — fichas livianas (§22 del paper)

> No leímos los papers completos a propósito: son roadmap post-hackathon, no dependencia del MVP.
> Cada ficha: qué es, qué tomamos, qué NO tomamos y porqué, cuándo.
> Fuentes verificadas sep-2026 al pie de cada ficha.

## 1. NVIDIA Dynamo — blueprint de routing + serving desagregado

**Qué es:** framework open-source (Apache 2) de serving LLM: separa prefill (compute-bound, mide TTFT) de decode
(memory-bound, mide ITL) en workers distintos, transfiere KV-cache directo VRAM→VRAM con NIXL (no bloqueante),
y rutea con función de costo sobre KV-overlap + carga (KV-aware routing, PrefillRouter, discovery vía etcd).
Backends: TRT-LLM, vLLM, SGLang. (`docs.nvidia.com/dynamo`, repo `ai-dynamo/dynamo`)

**Tomamos:** el vocabulario y la métrica — prefill vs decode separados en el ETR, y la idea de función de costo
para `Scheduler.select`. Nuestro `reason: warm-first` es la versión pobre del KV-aware routing.

**NO tomamos:** NIXL/RDMA, xPyD reconfigurable en runtime, NATS/etcd. Requieren multi-GPU con NVLink/InfiniBand;
en una Air + APIs no hay nada que transferir. Sería teatro.

**Cuándo:** fase Scale, cuando haya ≥2 Forges GPU reales y el p95 de decode mande.

## 2. Petals — prueba de que internet-churn es viable, y cómo

**Qué es:** sistema descentralizado (paper ACL'23 + NeurIPS'23, `petals.ml`) que corre BLOOM-176B / Llama-2-70B
sobre GPUs consumer geodistribuidas con pipeline parallelism: cada servidor atiende un tramo contiguo de capas.
Aportes clave: doble caché (servidor guarda KV, cliente guarda activaciones pasadas) para recuperarse de caídas
re-enviando solo O(t) en vez de reiniciar; DHT (Kademlia) para load-balancing de tramos; ruteo por latencia
medida con beam-search/shortest-path; cuantización dinámica de activaciones para partir bandwidth a la mitad.
≥10× más rápido que offloading local.

**Tomamos:** las 3 ideas que validan nuestra tesis — (a) fallback por re-ruteo es el mecanismo, no la excepción;
(b) el cliente guarda estado para reconstruir (nuestro `Idempotency-Key` + reintento es la versión mínima);
(c) ruteo por latencia medida, no por specs declaradas (nuestro ETR con RTT real).

**NO tomamos:** pipeline parallelism por capas ni DHT. Con modelos 3-8B enteros en un Forge no hay nada que
partir; partir sumaría hops de red que en 13 días no podemos medir ni estabilizar.

**Cuándo:** si post-hackathon aparece un modelo que no entra en ningún Forge singolo (modo B distribuido del paper).

## 3. Parallax — sharding solo cuando el modelo no entra

**Qué es:** framework (EuroSys'19, SNU, `snuspl/parallax`) de data-parallel training que elige arquitectura
según sparsity: Parameter Server para variables sparse, AllReduce para densas (híbrido), particionando las
grandes de forma near-óptima. Hasta 6× speedup en NMT/LM vs Horovod con 48 GPUs. Es de *training*, no inference.

**Tomamos:** casi nada directo — solo el principio "la arquitectura sigue a la forma del trabajo, no al revés"
(híbrido PS+AR ≈ nuestro warm-first + fallback: dos mecanismos, cada uno donde rinde).

**NO tomamos:** todo lo demás. Es training distribuido 2019 sobre TensorFlow; nuestro problema es inference
routing 2026. Citarlo en el pitch más allá de una línea sería humo.

**Cuándo:** nunca en inference; solo si Weaver algún día ofrece fine-tuning distribuido (fuera del paper v0.2).

## 4. NVIDIA PAIR — el primo LAN de Weaver (mirarlo de cerca)

**Qué es:** Personal AI Router (beta abierta, blog NVIDIA 03-sep-2026, open-source, `docs.nvidia.com/local-ai/nvpair`):
convierte máquinas de tu LAN en un solo endpoint. Proxy local Ollama/LM-Studio-compatible (el cliente no cambia
nada), discovery mDNS, pairing explícito con PIN de 6 dígitos + mTLS entre nodos, ruteo model-aware con estado
vivo (readiness, modelo presente, jobs activos, GPU util). El endpoint solo escucha en loopback; sin relay abierto.

**Tomamos:** es la validación más fuerte de nuestra tesis ("el usuario nunca elige infraestructura") y el patrón
concreto para el bootstrap LAN que el paper v0.2 menciona: discovery ≠ trust (mDNS ve, pairing autoriza),
endpoint compatible (OpenAI/Ollama) para no pedirle nada al cliente, ruteo con estado vivo.

**NO tomamos:** el binario PAIR en sí ni mTLS/PIN para el MVP — un solo nodo (tu Air) no necesita discovery.
Pero si en la semana aparece una 2ª máquina (la de un mentor, otra laptop), el story "PAIR adentro del cluster,
Weaver arriba cruzando clusters + settlement Stellar" es demo Day imposible de ignorar.

**Cuándo:** día 1 post-freeze si hay 2ª máquina; si no, queda como slide de roadmap con nombre y versión.
