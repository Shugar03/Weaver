# Spec 017 — pool-forge: inferencia pooled entre operadores independientes

Estado: **implementado (S46) — MVP verificado loopback + wire-e2e** · Origen:
ADR-0010 nivel 3 + docs/research/distributed-inference.md
Claim honesto del MVP: **"forges de operadores independientes combinan VRAM —
Weaver aporta coordinación, confianza y atribución; el transporte de
activaciones es llama.cpp RPC"**. No vendemos boundary-pipeline WAN todavía
(fase B, substrate prima.cpp o stage-server propio).

## Contexto

ADR-0010 nivel 2 ya verificó: `llama-server --rpc host:port --split-mode layer`
sirve un modelo repartido entre procesos/máquinas del MISMO operador, visto
por Weaver como UN forge. El nivel 3 (operadores distintos) no requiere un
transporte nuevo para un MVP: lo que falta es **coordinación** — quién presta
VRAM, a quién, con qué consentimiento, atribución y payout.

## Decisiones (de la investigación)

- Substrate MVP = llama.cpp RPC (op-level; LAN/decent-link — WAN documentado
  como lento, ver #15020). Boundary-activation WAN = fase B.
- El worker NUNCA ve prompts (solo tensores ggml) — privacidad más fuerte que
  Petals en ese punto.
- Gateway brokera el pairing: el endpoint del worker solo se revela al
  coordinator elegido dentro del `job.assign`, jamás en API pública.
- Payout MVP: escrow paga al coordinator; atribución del worker queda
  on-chain en el job record + ERC-8004 feedback tag `pool:{jobId}`.
  Revenue-share contract = fuera de scope.

## Diseño de wire (diff mínimo)

`protocol.ts`:

```ts
// InstanceReport
capability: "text" | "image" | "rpc-worker";
rpc?: { endpoint: string; vramGb?: number };   // solo rpc-worker
pool?: { needs: number };                      // coordinator: peers que pide

// JobAssignMsg (nuevo campo opcional)
rpcPeers?: string[];  // endpoints "host:port" elegidos por el gateway
```

Codec: validación estricta como el resto — `rpc-worker` requiere `rpc.endpoint`
`host:port` válido (≤253 chars, sin espacios); `rpcPeers` ≤4 items; `pool.needs`
entero 1-4. Campos extra ignorados como hoy.

## Daemon

**Modo worker (`--rpc-worker`)**: instancia sin exec — spawnea
`ggml-rpc-server -p <port>` (spawn inyectable para tests), health = proceso
vivo + port listening (probe inyectable). Reporta capability `rpc-worker`,
`rpc.endpoint = "<bindIp>:<port>"`, `vramGb` declarado por el operador.
`inFlight` refleja si está paired (el gateway lo marca, ver scheduler) — el
daemon no sabe de pairings; solo expone el server.

**Coordinator**: `job.assign` con `rpcPeers` → el daemon no usa el exec
residente sino `PooledExec`: spawnea `llama-server --rpc <peers> --split-mode
layer -m <model>` UNA VEZ por set de peers (warm, keyed por peers.join(",")),
y habla OpenAI-compatible contra él (reutiliza OpenAICompatAdapter internamente).
`job.cancel`/canal muerto abortan igual que un job normal (mismo `running` map);
el server pooled queda vivo (prestó GPU, no job-scoped) salvo que el daemon
muera. `spawn` inyectable → tests con proceso fake.

## Gateway / scheduler

- Registry: instancias `rpc-worker` quedan fuera del routing normal (nunca
  reciben `job.assign` directo — sin `model` ruteable).
- PoolPool: mapa `workerInstanceId → { forge, endpoint, busy: bool, vramGb }`.
- Routing: instancia con `pool.needs` es candidata solo si hay ≥needs workers
  libres → el assign incluye `rpcPeers` + workers marcados busy (atómico con
  el dispatch — mismo lugar que reserva inFlight hoy).
- Release: `job.done`/`job.fail`/abort/forge muerto → workers liberados
  (idempotente — misma disciplina que el running-map del daemon).
- Worker forge muere mid-job → su socket cierra → engine del coordinator
  crashea → `job.fail` → failover resume a otra ruta (maquinaria existente).
- Sin workers libres → el candidato pooled se salta (degradación honesta:
  ETR del siguiente forge, no hang).

## Confianza

- Proof: sin cambios al hash del MVP — el compromiso es input+output del
  coordinator (nivel 2 trust model del ADR: el coordinator responde por sus
  sub-workers). `participants: [coordinatorForge, ...workerForges]` queda en
  el job record + receipt + feedback ERC-8004 de AMBOS.
- Auditoría: el gateway puede exigir attestation al worker igual que a un
  forge normal antes de pairarlo (attestImage-style, fase A2 si alcanza).

## TDD — fases red→green

**A1 protocolo** (`forge-net/tests`): codec acepta rpc-worker+rpc+pool+rpcPeers,
rechaza endpoint malformado/>4 peers/needs inválido; heartbeat con rpc-worker
parsea.

**A2 daemon worker** (`forge/tests`): `--rpc-worker` mode → instancia
capability rpc-worker en el heartbeat con endpoint; spawn llamado con args
correctos; proceso muerto → saturated/report honesto.

**A3 daemon coordinator**: assign con rpcPeers → PooledExec spawned una vez
(peer-set keyed), segundo job mismo set reutiliza; cancel aborta job no mata
server; assign sin peers → exec residente intacto.

**A4 gateway pairing**: modelo pooled+worker libre → assign lleva rpcPeers y
worker busy; dos jobs compiten → el segundo salta a siguiente ruta o 404;
job.done libera; worker forge muere → busy limpiado + job failover.

**A5 wire-e2e** (`tests/e2e/pool.test.ts`, harness existente): upRpcDaemon +
upDaemon → job ruteado al coordinator lleva rpcPeers del worker real;
worker muere mid-stream → job.fail → resume; reconnect del worker → vuelve
al pool.

**A6 live gate + docs**: 2 procesos llama.cpp reales LAN (manual),
actualizar ADR-0010 (nivel 3 MVP implementado), writeup §6.2+, deck status.

## Fuera de scope (fase B+)

Boundary-activation WAN pipeline (prima.cpp), activation-replay failover,
payout splitting on-chain, `acceptPooled` opt-in por request, attestation
por stage encadenada, túnel seguro para rpc-server WAN.

## As-built (S46) — qué quedó implementado

- `protocol.ts`: `capability:"rpc-worker"`, `rpc:{endpoint,vramGb?}`,
  `pool:{needs,minVramGb?}` (1-4, minVram 1-2048), `JobAssignMsg.rpcPeers`
  (≤4, host:port estricto, IPv4/host/[IPv6]), `JobFailMsg.poolBlame`.
  Validación null-on-malformed como el resto del codec.
- `ForgePool` (`forge-net/pool.ts`): lease atómico **por jobId** — dos jobs
  concurrentes al mismo coordinator tienen préstamos independientes.
  `acquire` es async: reserva candidatos PRE-probe (atomicidad entre
  acquires concurrentes), probea TCP en paralelo (SPARE=2 candidatos
  extra), ordena por RTT medido, prefiere workers de OTRO forge.
  Filtros: `live`, `busy`, strikes penalizados (2 faltas → evict 120s,
  self-heal) y `minVramGb` (worker sin `vramGb` declarado no califica —
  conservador). `release(jobId)` idempotente; `penalize(jobId)` suma
  strikes antes de liberar; `releaseForge(pubkey)` al caer la sesión del
  coordinator; stale `busy` se evicta lazy por desaparición del worker.
- `registry.workers()`: los rpc-worker existen FUERA de `views()` — nunca
  entran al scheduler ni a attestation (recurso, no ruta).
- `RemoteForgeExec`: acquire antes del assign (null → throw pre-token →
  failover honesto), peers privados en `job.assign`, `poolBlame` →
  `penalize` antes de `release` en `finally`, `pooledFirstTokenMs`
  (default 300s) — el cold start del cluster no muere por el timeout
  normal de primer token.
- `apps/forge`: `--rpc-worker id:host:port` (init) + spawn
  `ggml-rpc-server -H host -p port` en up (`rpcproc.ts`); heartbeat
  `live`/`saturated` = `rpcProc.alive` **y** self-probe TCP del endpoint
  (`rpcProbe`, prod = `probeTcp`). `--pool N[:MINVRAM]` + `--model-file`
  → coordinator (maxConcurrent se clampa a 1: un llama-server por job);
  `pooledFactory` spawnea `llama-server -m F --rpc peers --split-mode
  layer --host 127.0.0.1 --port P` warm-keyed por peer-set con LRU
  acotado (`maxWarm` default 2, evict → SIGKILL), respawn si el warm
  murió, puerto con probe anti-colisión, health-check `/health` con
  boot timeout 300s y kill del proceso si no levanta.
- Defensa daemon-side (`daemon.ts`): `rpcPeers` solo se obedecen si la
  instancia declaró `pool` (un forge normal no diala endpoints
  arbitrarios), `allowRpcPeers` (allowlist operador, `--rpc-allow`
  prefijo/host — el gateway propone, el forge dispone), `pooledFactory`
  que lanza → `job.fail` con `poolBlame:true` (el gateway penaliza a los
  peers, no al coordinator).
- `forgews.ts`: attestation con retry (30s) para coordinators pooled —
  "sin workers" es transient, no roto.
- Tests: forge-net 80 (protocol + pool async/probe/strikes/vram +
  remote poolBlame/cold-start), forge 35 (daemon hardening ×6 +
  rpcproc LRU/respawn/port/health/dispose/abort ×8), gateway 209,
  e2e wire `tests/e2e/remote-pool.test.ts` ×4 — incluye attest-retry:
  coordinator sin workers → transient fail → worker llega → attested
  → sirve.
- Live gate loopback: 2×`ggml-rpc-server -d CPU` + `llama-server --rpc …
  --split-mode layer` sobre qwen3-4b GGUF real — health ok + completion +
  conexiones activas en ambos workers. Correcciones que solo salieron en
  vivo: bind es `-H` (`-h` = help) y `llama-server` toma `--port`.
- Pendiente del gate: 2 máquinas LAN reales (mismo procedimiento, el
  endpoint deja de ser 127.0.0.1) — nada de código cambia.

## Hardening (review CTO — qué se corrigió post-MVP)

| Hallazgo | Fix |
|---|---|
| Loans por coordinatorInstanceId → job B pisaba el préstamo del A | Loans keyed por `jobId` |
| Attest one-shot: pooled sin workers quedaba unroutable para siempre | Reintento throttled 30s en `syncExecs` |
| Endpoint envenenado: worker live pero sin socket → loop de fails | Probe TCP pre-assign + strikes → evicción 120s |
| Warm cache sin límite → N llama-servers = OOM | LRU `maxWarm` (default 2) con SIGKILL al evictar |
| Adapter zombie: warm server muerto servía contra puerto cadáver | `proc.alive` check → respawn limpio |
| `firstTokenTimeout` 60s mataba cold starts sanos de minutos | `pooledFirstTokenMs` 300s cuando hubo acquire |
| `rpcPeers` obedecidos por cualquier instance (dial arbitrario) | Rechazo si `!i.pool` + allowlist `allowRpcPeers` |
| `maxConcurrent>1` pooled → servers gigantes paralelos | Clamp a 1 en `--pool` (cli) |
| `vramGb` anunciado pero no usado en pairing | `pool.minVramGb` → filtro conservador en acquire |
| `live` = proc vivo, no endpoint alcanzable | `rpcProbe` self-probe TCP en heartbeat |
| Deadlock por iterador vivo de `warm.values()` | Snapshot antes de iterar (test LRU lo probó) |
| `job.cancel` durante el spawn pooled se perdía → servía a un consumidor muerto | `AbortController` en `running` ANTES del await; signal entra a la factory → `waitHealthy` aborta y mata el proceso |
| Spawn muerto por cancel → `poolBlame` penalizaba workers inocentes | `poolBlame` solo si `!ac.signal.aborted` |
| `daemon.stop()` no mataba warm servers → VRAM colgada | `PooledFactory.dispose()` — SIGKILL a todo el warm cache |

**Honestidad del modelo de confianza**: el coordinator recibe el prompt
completo y firma el proof — los workers solo ven tensores/activaciones por
ggml-rpc (sin prompt). PERO las activaciones intermedias y los shards de
pesos son parcialmente invertibles — esto NO es zero-knowledge execution.
Un operador de worker curioso puede inspeccionar el tráfico RPC. El claim
correcto es "los workers no ven el prompt", no "los workers no ven nada".
