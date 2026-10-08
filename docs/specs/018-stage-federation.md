# Spec 018 — stage-federation: pipeline por bloques entre forges independientes (WAN)

Estado: **implementado — fases A1-A4 + substrate real (C parcial) verificados por wire-e2e** · Origen: ADR-0010
nivel 3 + `docs/research/stage-federation.md` (Petals §3.2-3.5, TOPLOC,
VeriLLM, PRIME stack, prima.cpp). Substrate: `stage_runner.py` con pesos
HF reales (paridad bit-exacta probada); `stage-sim` queda para tests
rápidos del wire.

Claim honesto: **"un job de un modelo REAL se reparte por bloques contiguos
entre procesos/forges de operadores distintos — Weaver orquesta la cadena,
tolera caídas con replay de activaciones, y cada stage firma su tramo"**.
Transporte
relay-vía-coordinator (los stages solo hablan con quien les dio trabajo —
sin problema NAT para el middle-hop). Velocidad WAN: física RTT×profundidad
⇒ útil para modelos que ningún forge solo corre; no para chat snappy.

## Contexto

El nivel 2.5 (spec 017) demostró pairing Weaver-managed pero con transporte
op-level llama.cpp RPC — LAN-only y el coordinator controla todo. El nivel 3
necesita el primitivo correcto: **activaciones frontera entre stages con KV
server-side** (Petals, NeurIPS'23 — demostrado a 405B en swarms públicos).

La diferencia de protocolo respecto a 017: un `rpc-worker` presta cómputo
opaco (el coordinator llama); un `stage-worker` hospeda **bloques contiguos
del modelo** y procesa hidden-states en un loop de sesión — Weaver pasa de
"prestar VRAM" a "federar el grafo del modelo".

## Decisiones (de la investigación — evidencia → diseño)

| Decisión | Evidencia |
|---|---|
| Pipeline por bloques contiguos, MoE co-localizado | TP/EP mueren en WAN (all-reduce por capa; MixServe desbalance); Petals los validó |
| Coordinator-orquestado (modelo "cliente" Petals) | El que tiene los caches de replay debe orquestar (Petals Algo 1-3) |
| Relay vía coordinator en MVP | Middle stages NAT'd no aceptan inbound; directo+checksum = fase B |
| KV server-side por sesión | Petals Algo 2 — replay O(t) solo en stage caído |
| Firma hash por stage (MVP) → TOPLOC commitments (fase B) | TOPLOC: 258B/32tok, 100% detección, robusto a nondeterminismo |
| Gateway = el "DHT" (registry existente) | libp2p/DHT de Petals es peso muerto si ya hay registry central |
| Substrate: `stage-sim` para toda la capa Weaver → `llama.cpp --stage` para live | llama.cpp no expone fronteras de capa; prima.cpp es research-grade; el modo stage C++ es contenido pero es fase C |

## Arquitectura

```
   gateway (Registry + StagePool + chain builder)
      │  job.assign {stages:[{endpoint, blocks:[0..k]},{endpoint, blocks:[k..n]}]}
      ▼
coordinator forge (acepta el job)
   PipelineExec:
     embeddings(locales) → relay stage A → relay stage B → logits+muestreo
     cache[i] = activaciones enviadas al stage i   ← replay buffer
      │ stage.step {sessionId, seq, hidden[]}
      ▼                          ▼
  stage forge A            stage forge B
  blocks 0..k + KV         blocks k..n + KV
  (nunca ve tokens: solo hidden states + firma su tramo)
```

- **Stage-worker**: daemon `--stage-worker <model> <k..n>` — hospeda bloques
  contiguos, mantiene KV por sessionId, firma `hash(act_in)‖hash(act_out)‖jobId`.
  Anuncia `{model, layers:[k,n], vramGb, tpsMedido, endpoint}` en heartbeat.
- **Coordinator**: declara `pipeline: {model, blocks: n}` — "sirvo este modelo
  si me prestás N stages cubriendo [0..n)". Recibe `job.assign.stages`, arma
  `PipelineExec` (embeddings+lmhead+tokenizer LOCALES — el coordinator es la
  única pieza que ve plaintext además del cliente).
- **StagePool** (gateway, hereda de ForgePool): candidates = stage-workers con
  el modelo y rango necesario; pairing por rango de bloques + latencia medida;
  mismo ciclo de vida (acquire/release/penalize por jobId).

## Diseño de wire (diff sobre protocol.ts)

```ts
// InstanceReport
capability: ... | "stage-worker";
stage?: { model: string; layers: [number, number]; vramGb?: number;
          tps?: number; endpoint: string };   // solo stage-worker
pipeline?: { model: string; blocks: number }; // coordinator: cuántos bloques

// JobAssignMsg
stages?: { endpoint: string; blocks: [number, number] }[]; // privado, ≤6

// Nuevos msgs (canal forge↔forge, NO forge↔gateway)
stage.open  { jobId, sessionId, model, blocks:[k,n], kvLenHint? }
stage.step  { jobId, sessionId, seq, shape:[t,h], dtype, payload:b64|bin }
stage.done  { jobId, sessionId, sig }
stage.fail  { jobId, sessionId, error }
```

Codec: `layers` rango válido `k<n`, `endpoint` host:port, `shape` dims ≤4
positivas, `payload` ≤256KB/frame (activación max esperada ~40KB/token MoE).
Campos extra ignorados.

## Fases (SDD — cada fase termina con gate ejecutable)

**A1 — protocolo + stage-worker daemon** (TDD rojo→verde):
- codec `stage`, `pipeline`, `stages`, msgs `stage.*` (tests codec).
- daemon `--stage-worker`: instancia con `stageExec` inyectable; heartbeat
  reporta rango+endpoint; **nunca recibe `job.assign` con `prompt`** — si
  llega uno, `job.fail` inmediato (fuera del scheduler, igual que rpc-worker).
- Gate: `forge-net` tests verdes; daemon rechaza prompts en modo stage.

**A2 — StagePool + chain builder** (TDD):
- `StagePool.acquire(coordinatorId, model, totalBlocks, jobId)` → devuelve
  cadena de stages cuya unión de rangos cubre [0..totalBlocks) sin huecos —
  o `null` (honesto: falta capacidad).
- Selección: shortest-path sobre latencia medida al coordinator + `tps`
  declarado (D* Lite simplificado: Dijkstra con ban-set; el grafo es chico —
  no necesitamos lifelong incremental en MVP).
- Reservas por jobId (hereda la maquinaria de pool.ts: probe, strikes, ban).
- Gate: pairing correcto con rangos parciales, hueco → null, muerto → ban.

**A3 — PipelineExec en el coordinator** (TDD, el núcleo — Petals Algo 1):
- `session.open` por stage → loop `stage.step` relay → logits → token.
- **Dual cache**: `cache[stage]` = activaciones enviadas; stage muere →
  ban + reemplazo del heap + **replay** de las activaciones cacheadas →
  `chain.replace` → el job sigue donde quedó.
- `stage.fail`/timeout → blame del stage (penalize) no del coordinator.
- Cancel: `job.cancel` propaga `stage.close` a todos → KV liberado.
- Gate: job corre a través de 2 stages con cómputo stub; muerte mid-stream →
  re-chain + replay sin perder tokens; cancel limpia todos los sessions.

**A4 — firma por stage + BDD wire-e2e**:
- Cada `stage.step` devuelve `sig = sign(hash(in)‖hash(out)‖jobId)`; el
  coordinator acumula la cadena y la incluye en `job.done {stageSigs:[...]}`.
- Gateway verifica: los endpoints firmantes == los que asignó (anti-
  sustitución — un stage no puede hacerse pasar por otro tramo).
- BDD (Given/When/Then sobre harness real):
  - *Given* stages S1[0..20) S2[20..40) registrados + coordinator pidiendo 40
    bloques, *When* llega un job, *Then* assign lleva la cadena ordenada y el
    pipeline corre boundary a boundary.
  - *Given* pipeline corriendo, *When* S2 muere a mitad del stream, *Then* el
    coordinator banea S2, reemplaza con S2' del heap, hace replay de activaciones
    cacheadas y completa sin reenviar el prompt (honest failure→recovery).
  - *Given* coordinator muere, *Then* stages reciben `stage.close` (session
    cleanup) — los workers no quedan con KV zombie.
  - *Given* un stage devuelve activación con firma inválida, *Then* blame va
    al stage (penalize), no al coordinator.
- Gate: e2e verde con stage-sim real por WS/TCP (no mocks).

**B — WAN hardening (post-MVP)**:
- **B1 — capability tokens en `stage.open`** (✅ implementado): antes de B1,
  cualquier cliente TCP de Internet podía abrir sesiones e inyectar
  activaciones en un stage endpoint. Ahora el daemon del worker mintea
  `token = HMAC-SHA256(stageSecret, jobId|coordPubkey)` a pedido del gateway
  (`stage.grant` → `stage.token`); el gateway lo porta opaco dentro de
  `job.assign.stages[]`/`stage.offer`; el coordinator lo presenta en
  `stage.open` junto a su pubkey; el stage (TS y Python) verifica el HMAC
  **antes** de alocar sesión/KV — inválido o ausente → `stage.fail` cerrado.
  Grant timeout = worker no confiable → strike + re-chain (misma disciplina
  que probe). Los replacements reciben capability fresca. `--stage-secret`/
  `WEAVER_STAGE_SECRET`; stage-worker sin secret loguea warning y nunca es
  prestado (fail closed).
- Pendiente: directo stage→stage con checksum async (Petals §3.2), dynamic
  blockwise quant de hidden states, TOPLOC commitments, NAT traversal o
  relay-pool, payout-split on-chain por stage, `acceptPooled` opt-in
  explícito del usuario, rotación/escopado fino de `stageSecret` (hoy es un
  shared secret por daemon — un coordinator malicioso con token puede hablar
  ese tramo; la firma A4 sigue atando el historial).

**C — substrate real**: `llama.cpp --stage k..n --hidden-in/--hidden-out`
(modo stage en nuestro build, ~C++ contenido) — sustituye stage-sim en live
gate con pesos reales.

## Lo que NO se promete (honestidad)

- Latencia WAN: RTT×profundidad ⇒ **~5-25 tok/s** techo — sirve >200B que
  nadie solo corre y batch; no chat fluido ni competirle a la API del maker.
- Privacidad: activaciones intermedias **parcialmente invertibles** — la
  promesa se degrada a "representaciones internas"; `acceptPooled` opt-in.
- El coordinator ve el prompt entero (embeddings locales) — trust-anchor
  del pipeline; stages nunca ven plaintext.
- Stages deben ser alcanzables por el coordinator (endpoint público o relay)
  — NAT traversal queda fuera del MVP.

## Tests (mapa TDD — rojo primero, luego verde)

| Capa | Tests |
|---|---|
| `protocol.test.ts` | codec `stage`, `pipeline`, `stages`, `stage.*` msgs; shape/payload bounds |
| `daemon.test.ts` | stage-worker heartbeat, rechazo de `job.assign` con prompt, session lifecycle, KV por sessionId, close en cancel/disconnect |
| `stagepool.test.ts` (nuevo) | pairing por rango, hueco→null, orden por latencia, dead→ban, release por jobId |
| `pipeline.test.ts` (nuevo) | Petals Algo 1: relay loop, dual-cache, re-chain+replay, blame routing, cancel propagado, stageSigs en done |
| `forgews.test.ts` | assign lleva `stages` privado, no en API pública, attest del coordinator |
| `e2e` (harness) | los 4 escenarios BDD de A4 sobre transporte real |

## Riesgos

- El relay duplica hops en decode (petals directo los evita) — aceptado en
  MVP; fase B lo corrige sin cambio de protocolo (assign ya lleva endpoints).
- Session KV zombie si el coordinator muere sin `stage.close` — mitigación:
  timeout server-side por sessionId + el daemon cierra sessions al canal caer.
- Substrate stage-sim valida protocolo pero NO pesos reales — el gate C
  (llama.cpp --stage) es donde se prueba que un modelo gigante real corre.

## As-built (lo que corre hoy — verificado por wire-e2e)

Implementación completa de las fases A1-A4 con desviaciones documentadas:

| Componente | Dónde | Estado |
|---|---|---|
| Codec `stage`/`pipeline`/`stages` + `stage.need`/`stage.offer` | `forge-net/protocol.ts` | ✅ estricto, tests verdes |
| Canal forge↔forge (`stage.open/step/close/ack/out/fail`) | `forge-net/stageproto.ts` | ✅ JSON-lines acotado (seq/payload bounds) |
| StagePool + chain builder cobertura [0..n) + `replace()` | `forge-net/stagepool.ts` | ✅ loans/probes/strikes igual que ForgePool |
| `stageWorkers()` fuera del routing (recurso, no ruta) | `forge-net/registry.ts` | ✅ |
| stage-worker daemon (heartbeat, rechaza prompts, session lifecycle) | `forge/daemon.ts` + `stageserver.ts` | ✅ socket muerto → sesiones liberadas |
| PipelineExec (Petals Algo 1-3: relay, dual-cache, heal+replay) | `forge/pipeline.ts` | ✅ heal verificado mid-job |
| Transport TCP coordinator→stage (`tcpStageDial`) | `forge/stagetransport.ts` | ✅ socket real en tests |
| `stage.need`→`stage.offer` heal por canal gateway | `daemon.ts` + `forgews.ts` | ✅ 10s timeout → vacío honesto |
| CLI `--stage-worker` `--stage-model` `--pipeline` | `forge/cli.ts` | ✅ warn "substrate: sim" |
| Firma por stage (stageSigs en done + verif gateway) | `stageproto` chain + `pipeline.ts` + `stagepool.chainOf` + `remote.verifyStageSigs` | ✅ ed25519 real en e2e; inválida → strike+drop, ajena → ignorada |
| `weaver_proof.stageSigs` visible al cliente | `gateway/index.ts` receipt | ✅ solo entradas verificadas |
| Substrate pesos reales | `tools/stage_runner.py` (HF slice k..n + KV sesión) + `--role edge` + `httpFront` + `--stage-ext` | ✅ Qwen2.5-0.5B partido 0-12/12-24 en 3 procesos → tokens idénticos al monolítico (paridad Δ=0 en `tools/parity_check.py`), stageSigs ed25519 reales |
| B1 capability tokens | `stageToken()` en `stageproto.ts` + `stage.grant`/`stage.token` en `protocol.ts` + grant en `forgews.ts` + mint en `daemon.ts` + verify en `stagetransport.ts`/`stage_runner.py` | ✅ rogue TCP sin token rechazado en e2e; auth obligatoria en toda la suite |

Desviaciones vs el diseño original:

- **Heal por el canal gateway** (`stage.need`/`stage.offer`), no re-chain
  client-side contra el heap: el pool es la ÚNICA autoridad de leases —
  un replace client-side crearía split-brain (dos loans sobre el mismo
  worker). El muerto se reporta por endpoint (lo que el coordinator ve).
- **`replace()` excluye al muerto de los candidatos** — bug pescado por
  test: con 1 strike seguía elegible y se autoelegía como reemplazo.
- **stage-worker `inFlight` = sesiones activas** en heartbeat — el pool
  sabe cuándo su KV está ocupado (maxConcurrent=1 → una sesión).
- **pipeline coordinator sin exec local**: heartbeat lo reporta hot por
  declaración (su capacidad la decide el StagePool en cada acquire, no un
  engine residente que no existe).
- **Firma al CLOSE, no por step** (decisión A4): el stage acumula
  `chain = sha256(chain‖seq‖in‖out)` por step; al `stage.close` firma
  `sha256(jobId:sessionId:chain)` con su keypair de forge. El coordinator
  recomputa el mismo chain sobre el tráfico que ve → `job.done.stageSigs`
  → gateway verifica `endpoint→forgePubkey` del loan (StagePool lo retiene
  aunque el worker ya se haya ido). Firma inválida → `strikeWorker` +
  entrada descartada; endpoint ajeno al loan → ignorado sin penalizar.
  El muerto no firma — el reemplazo firma SU sesión (loan actualizado).
  Una firma por stage por job: no hay N firmas por token (MVP honesto —
  ata el historial de activaciones completo, no cada step por separado).
- **Substrate real = `tools/stage_runner.py`** (fase C parcial): HF slice
  `layers[k:n]` + `rotary_emb` + `DynamicCache` por sesión — paridad
  bit-exacta vs monolítico (`tools/parity_check.py`: Δ=0 prefill y decode
  greedy idéntico). Edge-runner (`--role edge`) sirve embed+norm+lm_head+
  tokenizer por HTTP stateless; `httpFront` lo consume (PipelineFront
  ahora async). El stage firma con ed25519 derivado del seed Stellar del
  daemon (`--sign-seed S...`) — una sola identidad por proceso. Lo que
  falta de C: runner nativo llama.cpp/GGUF (CUDA/Metal real), cuantización
  de activaciones (hoy f16 b64), y forward vía MPS/CUDA (hoy CPU fp32).

Bugs reales que solo salieron en implementación:

- `spawnEntry` iteraba `warm.values()` vivo → deadlock (S46, ya fixeado).
- El tag del spare en el test no casaba la regex `:s\d+` → token huérfano
  infinito (bug del sim, no del protocolo).
- `srv.close()` no mataba sockets establecidos → el heal nunca disparaba
  (ahora `close()` destruye conexiones, como un crash real).
- `seenSeqs` agregado al sim-compute: el replay es asertable post-close.

- `t.close()` era fire-and-forget → ahora `Promise<{sig?}>` con wait
  acotado (5s): el ack viaja con la firma; muerto/timeout → `{}` honesto.
- La entrada de chain del muerto debe salir del loan **por endpoint** aunque
  su instance ya no esté en `stageWorkers()` — si no, una sig zombie
  seguiría atribuible (lo arregla `replace()`).
- `it.return()` no interrumpe un `await` en vuelo — el release del loan
  viaja sobre la promesa del acquire, no sobre un flag post-await (S46).
- B1: `instanceOwner` se llenaba solo desde `registry.views()` — que
  **excluye** stage/rpc-workers por diseño (son recursos del pool, no rutas).
  El grant nunca encontraba el canal del worker → timeout → strike → cadena
  imposible → attest del coordinator fallaba con `sin execs`. Fix:
  `syncExecs()` registra owners desde `stageWorkers()`+`workers()` además de
  las views. Lección: el gateway habla con los workers por DOS caminos —
  el scheduler (views) y el pool (loans) — y el segundo necesita su propio
  mapa de sesiones.
- B1: activar `grant` obligatorio hizo fallar toda la e2e con `sin execs` —
  los daemons stage del harness no tenían secret, todos los grants daban
  timeout y el pool los marcaba no-confiables. Correcto en espíritu (un
  stage WAN sin auth es un agujero): el harness ahora usa
  `WEAVER_STAGE_SECRET=e2e-stage-secret` por defecto en todos los daemons
  stage — **toda la suite corre con auth real**, no solo el test B1.

Regresión: forge-net 124 · forge 61 · gateway 209 · e2e 16 (15 sim + 1
pesos reales Qwen2.5-0.5B split 0-12/12-24, ambos con B1 auth) — todo verde.
