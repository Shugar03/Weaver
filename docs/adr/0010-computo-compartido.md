# ADR 0010 — Cómputo compartido: cluster-forge hoy, pipeline inter-forge mañana

Fecha: 2026-10-08 · Estado: aceptado (nivel 1 implementado; nivel 2 verificado;
**nivel 2.5 — pool entre operadores — implementado** en spec 017; nivel 3
stage-federation especificado, no implementado)

## Contexto

Los modelos frontera open-weight (Qwen3-235B, DeepSeek, MiniMax) exceden el
VRAM de una sola GPU de consumo. La pregunta de producto: ¿Weaver puede servir
inferencia que requiere cómputo repartido entre varias máquinas — y con qué
modelo de confianza?

Tres niveles distintos, que NO hay que confundir:

1. **Modelo grande en UN forge con hardware suficiente.** Ya funciona: el
   protocolo es agnóstico al peso del modelo — ETR medido, proof, escrow.
   Con `OpenAICompatAdapter` (vLLM / llama.cpp-server), un forge sirve
   32B/70B quantizados, AWQ/GPTQ/FP8, y tensor-parallel multi-GPU local.
2. **Cluster bajo UN operador = UN forge.** Varias máquinas del mismo dueño
   reparten capas (llama.cpp RPC, vLLM+Ray, tensor-parallel). Weaver ve una
   identidad, un proof, un payout. **No cambia el modelo de confianza** — el
   operador responde por sus sub-workers. Implementable hoy sin protocolo
   nuevo.
3. **Pipeline entre forges INDEPENDIENTES** (operadores distintos, redes
   distintas, sin confianza mutua). Stage A procesa capas 0..k, stage B k..n,
   pasándose activaciones por WAN. Esto es un protocolo nuevo, no una feature.

## Decisión

- **Implementado:** nivel 1 + el adapter OpenAI-compatible que habilita
  nivel 2 vía software externo (vLLM tensor-parallel, llama.cpp RPC server).
- **Verificado live (nivel 2):** `ggml-rpc-server` ×2 + `llama-server
  --rpc host1,host2 --split-mode layer` sirviendo qwen3-4b Q4_K_M con capas
  repartidas entre dos procesos. `OpenAICompatAdapter` lo sirvió como UN
  forge (probe/resident/exec 1.1s reales). Prueba de distribución real:
  matar un worker crasheó el front — el cómputo estaba delegado, no
  replicado. En LAN los workers son máquinas distintas con el mismo binario.
- **Implementado (nivel 2.5, spec 017 — S46):** pool entre operadores
  distintos. Un forge `rpc-worker` presta su `ggml-rpc-server` (nunca ve
  prompts — solo tensores); el gateway lo empareja con un coordinator que
  declara `pool.needs` al despachar el job (`job.assign.rpcPeers`, privado);
  el coordinator spawnea `llama-server --rpc peers --split-mode layer`
  warm-keyed por peer-set. Trust = modelo de nivel 2: el coordinator firma
  el proof y responde por sus sub-workers; los endpoints jamás salen en API
  pública. Workers: recurso del pool, NO rutas (fuera del scheduler, fuera
  de attestation). Leases: acquire atómico + release en done/fail/cancel/
  disconnect; `live` reportado por heartbeat real del rpc-server.
- **Verificado live (nivel 2.5, loopback):** 2×`ggml-rpc-server -d CPU` +
  `llama-server --rpc 127.0.0.1:50052,127.0.0.1:50053 --split-mode layer`
  sirviendo qwen3-4b GGUF — `/health` ok y completion real con conexiones
  activas en ambos workers (delegación, no réplica). Bugs que solo el live
  gate expuso: `-h` es `--help` (el bind es `-H`), `llama-server` usa
  `--port` (no `-p`), y Metal OOM si Ollama tiene la GPU residente — en
  multi-tenant real cada worker vive en SU máquina/GPU.
- **Especificado acá:** nivel 3 (stage federation con boundary activations,
  cadena de proofs por stage, payout split). NO implementado — el MVP pooled
  usa transporte op-level llama.cpp RPC (LAN/link decente; WAN documentado
  lento en la investigación) que es la fase B del spec 017.

## Nivel 2.5 → qué se puede decir honestamente

"Forges de operadores distintos combinan VRAM" es cierto HOY con la
salvedad: transporte llama.cpp RPC (LAN/red privada — ggml-rpc-server no
tiene auth; no exponer a WAN abierto), la cadena de confianza ancla en el
coordinator, y el payout va al coordinator (split = fase B). Es la prueba
de que Weaver aporta lo que le falta a la técnica existente: coordinación,
identidad, confianza y atribución.

## Nivel 3 — diseño honesto

### Lo que es físicamente viable

- Activaciones inter-stage son chicas: ~hidden_size×2 bytes/token
  (8KB/tok en clase 32B, ~40KB en MoE grande). Prefill viaja en chunks —
  bandwidth WAN alcanza.
- **Latencia: el techo real.** Cada token cruza N fronteras × RTT. WAN típico
  30-80ms ⇒ 2 stages ≈ 12-25 tok/s techo. Sirve para throughput/batch y
  modelos que de otra forma NO caben — no para TTFT snappy en modelos chicos.

### Trust: chained attestation

El proof L0 actual ata input→output de UN forge. En pipeline:

- Cada stage firma `sig_i = sign(hash(act_in_i) ‖ hash(act_out_i) ‖ jobId)` —
  cadena de custodia. El último stage produce el proof normal.
- Auditoría optimista: el gateway puede re-ejecutar un stage aleatorio y
  comparar hash de activación (replay sampling) — trampa costosa para un
  stage deshonesto que no sabe cuál se re-verifica.
- Slashing/reputación por stage, no por pipeline completo — attribution
  granular.

### Privacidad: el costo honesto

Las activaciones intermedias son **invertibles parcialmente** — un stage
intermedio puede filtrar información del prompt. Consecuencias:

- ZDR sigue siendo cierto (nada persiste), pero la promesa de privacidad se
  debilita: la cadena ve representaciones internas, no plaintext.
- Mitigaciones posibles: pipeline solo bajo política explícita del usuario
  ("acepto multi-operador"), stages en jurisdicciones declaradas, o reserved
  para workloads no-sensibles. Se documenta, no se esconde.

### Lo que falta para implementarlo

1. `stage.assign`/`stage.chunk` en forge-net (activaciones binarias, no tokens).
2. Stage-runner que exponga fronteras de capa — Ollama no las expone; el
   candidato real es un servidor de stages propio sobre llama.cpp/vLLM.
3. Scheduler multi-hop: ETR del pipeline = Σ stages + RTT estimado.
4. Proof chaining + payout splitting por stage.
5. Replay audit opcional.

**Estimación honesta: semanas de protocolo, no días.** Con el nivel 2.5
implementado el camino es: pool LAN/privado real hoy (coordinación Weaver +
transporte llama.cpp RPC) → stage-federation WAN como fase B (boundary
activations, proofs por stage, payout split, túnel autenticado).

## Consecuencias

- El catálogo puede listar modelos grosos HOY si un forge con el hardware los
  sirve — el mercado ya lo soporta.
- "Shared compute" en el pitch = pool-forge implementado (nivel 2.5, LAN) +
  ADR (nivel 3). Claim preciso: "independent forges pool VRAM — Weaver
  supplies coordination, identity and attribution; activations ride
  llama.cpp RPC". No esconder: es LAN/privado hasta que haya túnel auth
  (fase B), y el proof/payout ancla en el coordinator.
