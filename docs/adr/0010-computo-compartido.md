# ADR 0010 — Cómputo compartido: cluster-forge hoy, pipeline inter-forge mañana

Fecha: 2026-10-08 · Estado: aceptado (nivel 1 implementado; nivel 3 especificado, no implementado)

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
- **Especificado acá:** nivel 3 (stage federation). No implementado — la
  honestidad exige decirlo: el pitch no puede vender "GPUs de desconocidos
  combinadas" hasta que este ADR tenga código detrás.

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

**Estimación honesta: semanas de protocolo, no días.** Para el submission el
camino es: nivel 2 demoable (cluster llama.cpp RPC como un forge) + este ADR
como el diseño serio — los jueces premian la honestidad sobre el teatro.

## Consecuencias

- El catálogo puede listar modelos grosos HOY si un forge con el hardware los
  sirve — el mercado ya lo soporta.
- "Shared compute" en el pitch = cluster-forge (nivel 2) + ADR (nivel 3).
  Nunca "forges de extraños ya combinan GPUs" — falso.
