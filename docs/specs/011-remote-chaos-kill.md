# Spec 011 — Chaos kill sobre forges remotos (live failover)

## Problema

`/v1/admin/kill` solo controla forges embedded — la fleet demo es 100% remota
→ "forge no controlable" (404). El momento demo más vendible de Weaver
("matá un forge y el request sobrevive") no se puede ejecutar.

## Diseño

```
POST /v1/admin/kill {forgeId: "live1", dead: true}
        │
        ▼
forgeWS.setDead("live1", true)
        │ registry.pubkeyOf(instanceId) → pubkey dueña
        ▼
killed.add(pubkey) + session.closed() + socket.close(4005)
        │
        ├──► registry.unregister → la instance sale de routing/views
        ├──► closeListeners → pending job rechaza → failover al siguiente
        └──► forge reintenta conectar → onAuthed rechaza (killed) hasta revive
```

### Semántica

- Kill mata el FORGE entero (su pubkey = su rig): todas sus instances caen,
  como un rig real que se apaga.
- Revive = `dead:false` → la pubkey sale del set; el daemon reintenta solo
  (~3s), re-authentica, re-attesta, vuelve a routing. Nada queda
  permanentemente roto.
- Kill de instanceId desconocido → false → 404 honesto.
- Pre-token: failover transparente al siguiente candidato (FailoverExec).
  Mid-stream: error explícito, jamás truncado silencioso (semántica S3
  intacta — el chaos no la cambia).
- `undefined` sin forgeId en REMOTE_ONLY → 404 (el kill global solo tiene
  sentido con embedded; matar toda la fleet remota no es demo, es autodestrucción).

## TDD

1. KillSwitch unit: kill instance conocida → pubkey killed + closeSession
   llamada; revive → desbloquea; desconocida → false.
2. Route: POST /v1/admin/kill con chaos remoto → {dead:true, forgeId}.
3. Reconnect gate: isKilled(pk) true tras kill → onAuthed rechaza.
4. Live: kill live1 mid-request → failover a live2, stream completa.
