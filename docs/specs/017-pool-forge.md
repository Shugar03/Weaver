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
  `pool:{needs}` (1-4), `JobAssignMsg.rpcPeers` (≤4, host:port estricto,
  IPv4/host/[IPv6]). Validación null-on-malformed como el resto del codec.
- `ForgePool` (`forge-net/pool.ts`): lease atómico — `acquire` ordena por
  RTT medido, prefiere workers de OTRO forge que el coordinator, marca
  busy; `release` idempotente en done/fail/cancel; `releaseForge` al caer
  la sesión del coordinator; workers stale se evictan lazy por `live`.
- `registry.workers()`: los rpc-worker existen FUERA de `views()` — nunca
  entran al scheduler ni a attestation (recurso, no ruta).
- `RemoteForgeExec`: acquire antes del assign (null → throw pre-token →
  failover honesto), peers privados en `job.assign`, release en `finally`.
- `apps/forge`: `--rpc-worker id:host:port` (init) + spawn
  `ggml-rpc-server -H host -p port` en up (`rpcproc.ts`); heartbeat
  `live`/`saturated` refleja el proceso real (`rpcProc.alive`).
  `--pool N` + `--model-file` → coordinator; `pooledFactory` spawnea
  `llama-server -m F --rpc peers --split-mode layer --host 127.0.0.1
  --port P` warm-keyed por peer-set y devuelve `OpenAICompatAdapter`.
  Hijos mueren con el daemon (SIGINT/exit → SIGKILL).
- Tests: protocol 61 + pool 7 + remote 4 (forge-net), daemon 24,
  e2e wire `tests/e2e/remote-pool.test.ts` ×3 — pairing con endpoint real
  espiado en `pooledFactory`, worker muerto → `forge-failed` en-stream
  honesto, recuperación `live` → pool sirve de nuevo.
- Live gate loopback: 2×`ggml-rpc-server -d CPU` + `llama-server --rpc …
  --split-mode layer` sobre qwen3-4b GGUF real — health ok + completion +
  conexiones activas en ambos workers. Correcciones que solo salieron en
  vivo: bind es `-H` (`-h` = help) y `llama-server` toma `--port`.
- Pendiente del gate: 2 máquinas LAN reales (mismo procedimiento, el
  endpoint deja de ser 127.0.0.1) — nada de código cambia.
