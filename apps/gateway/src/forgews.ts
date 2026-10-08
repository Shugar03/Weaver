// S31/S32 — adapter WS: sockets reales → ForgeSession (protocolo puro en
// forge-net). El forge marca outbound a /v1/forge/ws (mining-pool): auth con
// nonce firmado, heartbeats cada ~5s, jobs bajan por el mismo canal.
// Vive en serve.ts (composition root) — createApp nunca ve sockets, los tests
// de rutas siguen usando app.request.
import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  ForgePool,
  ForgeSession,
  RemoteForgeExec,
  RemoteImageExec,
  StagePool,
  type ForgeRegistry,
  type NonceStore,
  type VerifyFn,
} from "@weaver/forge-net";
import { TrackedExec, TrackedImageExec } from "@weaver/forge-exec";
import type { ForgeExec, ImageExec, Proof } from "@weaver/forge-exec";
import { imageDims } from "@weaver/forge-net";
import type { ForgeView } from "@weaver/scheduler";

export type ForgeWS = {
  // Execs vivos por instanceId — TrackedExec ya envuelto (inFlight medido
  // gateway-side: no confiamos solo en el self-report del heartbeat).
  remoteExecs: Map<string, ForgeExec>;
  remoteImageExecs: Map<string, ImageExec>;
  sessions: Map<string, ForgeSession>; // pubkey → session
  // spec 011: chaos kill sobre forges REMOTOS — mata la sesión del pubkey
  // dueño del instanceId y bloquea su reconexión hasta revive (dead:false).
  setDead(instanceId: string, dead: boolean): boolean;
  stop(): void;
};

// spec 011 — el kill switch remoto, puro y testeable sin sockets:
// resuelve instanceId→pubkey, mantiene el set de matados, cierra la sesión
// real por callback. El gate de reconexión vive en isKilled (onAuthed lo lee).
export function makeKillSwitch(deps: {
  pubkeyOf: (instanceId: string) => string | undefined;
  closeSession: (pubkey: string) => void;
}): { setDead(instanceId: string, dead: boolean): boolean; isKilled(pubkey: string): boolean } {
  const killed = new Set<string>();
  // instanceId → pubkey recordada al matar: post-kill la instance sale de
  // views/owner (unregister) — sin este mapa, revive jamás resuelve la pubkey
  // y el forge queda muerto hasta restart del gateway.
  const remembered = new Map<string, string>();
  return {
    isKilled: (pk) => killed.has(pk),
    setDead(instanceId, dead) {
      const pk = deps.pubkeyOf(instanceId) ?? remembered.get(instanceId);
      if (!pk) return false;
      if (!dead) {
        killed.delete(pk);
        remembered.delete(instanceId);
        return true;
      }
      remembered.set(instanceId, pk);
      // Idempotente: si la pubkey ya está matada, el objetivo se cumplió —
      // no hay segunda closeSession (la sesión ya no existe).
      if (!killed.has(pk)) {
        killed.add(pk);
        deps.closeSession(pk);
      }
      return true;
    },
  };
}

export function attachForgeWS(
  server: Server,
  deps: {
    registry: ForgeRegistry;
    nonces: NonceStore;
    verify: VerifyFn;
    // Probe TCP a los endpoints rpc-worker (default real). Tests e2e inyectan
    // uno — sus endpoints son IPs fake que nunca contestarían un SYN.
    poolProbe?: (endpoint: string) => Promise<boolean>;
    // Idem para stage-workers (S47) — el e2e los corre sobre TCP real.
    stageProbe?: (endpoint: string) => Promise<boolean>;
    // Throttle del retry de attestation para coordinators pooled (default
    // 30s). Los e2e lo bajan — sino un test tardaría medio minuto.
    attestRetryMs?: number;
  },
): ForgeWS {
  // maxPayload 1MiB: chunks/done son KBs — un frame gigante de un daemon
  // malicioso no puede inflar memoria del gateway (default ws = 100MiB).
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const sessions = new Map<string, ForgeSession>();
  const sockets = new Map<ForgeSession, WebSocket>();
  const remoteExecs = new Map<string, ForgeExec>();
  const remoteImageExecs = new Map<string, ImageExec>();
  const instanceOwner = new Map<string, ForgeSession>();
  // S46 pool-forge: reserva de rpc-workers en el instante del assign.
  // Un pool por attach — los loans mueren con la sesión del coordinator.
  const pool = new ForgePool({
    reportOf: (i) => deps.registry.reportOf(i),
    workers: () => deps.registry.workers(),
    ...(deps.poolProbe ? { probe: deps.poolProbe } : {}),
  });
  // S47 stage-federation: cadena de stage-workers para coordinators
  // federados — mismo contrato de loans/probes/strikes que ForgePool.
  const stagePool = new StagePool({
    reportOf: (i) => deps.registry.reportOf(i),
    stageWorkers: () => deps.registry.stageWorkers(),
    ...(deps.stageProbe ? { probe: deps.stageProbe } : {}),
  });
  // Reintento de attestation para coordinators pooled: el primer attest
  // puede fallar por "pool insuficiente" — condición TRANSIENTE (los workers
  // conectan después). Sin retry la instance queda unroutable para siempre.
  const lastAttest = new Map<string, number>();
  const ATTEST_RETRY_MS = deps.attestRetryMs ?? 30_000;
  // spec 011: pubkeys matadas por chaos — reconectar no revive hasta revive.
  const kill = makeKillSwitch({
    // instanceId → pubkey: del registry (fuente de verdad post-heartbeat)
    // o del owner si el view ya no está (kill doble tras expiry).
    pubkeyOf: (instanceId) => deps.registry.pubkeyOf(instanceId) ?? instanceOwner.get(instanceId)?.pubkey ?? undefined,
    closeSession: (pk) => {
      const s = sessions.get(pk);
      if (s) {
        s.closed(); // registry.unregister + closeListeners → pending jobs fallan → failover
        sockets.get(s)?.close(4005, "chaos kill");
        dropSession(s);
      }
    },
  });

  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/v1/forge/ws") return; // otros upgrades no son nuestros
    wss.handleUpgrade(req, socket, head, (ws) => onConn(ws));
  });

  function onConn(ws: WebSocket): void {
    const session = new ForgeSession({
      send: (raw) => {
        if (ws.readyState === ws.OPEN) ws.send(raw);
      },
      requestClose: () => ws.close(4003, "forge protocol"),
      registry: deps.registry,
      verify: deps.verify,
      consumeNonce: (n) => deps.nonces.consume(n),
      onAuthed: (s) => {
        // spec 011: pubkey matada por chaos → reconectar no revive. El forge
        // reintenta en loop; revive lo saca del set y la próxima auth entra.
        if (kill.isKilled(s.pubkey!)) {
          s.closed();
          ws.close(4005, "chaos kill");
          return;
        }
        // Pubkey ya conectado → kick al viejo (la máquina reintenta tras crash).
        const prev = sessions.get(s.pubkey!);
        if (prev && prev !== s) {
          prev.closed();
          sockets.get(prev)?.close(4001, "replaced");
        }
        sessions.set(s.pubkey!, s);
      },
    });
    sockets.set(session, ws);
    // S47 heal: el coordinator pide un stage de reemplazo mid-job. El pool
    // responde por ESTA sesión — un stage.need de otra forge no toca loans
    // ajenos (replace solo mira el loan de ese jobId).
    session.onMessage((m) => {
      if (m.type !== "stage.need") return;
      void stagePool
        .replace(m.jobId, m.dead, m.blocks)
        .then((r) =>
          session.send({
            type: "stage.offer",
            jobId: m.jobId,
            ...(r ? { endpoint: r.endpoint, blocks: r.blocks } : {}),
          }),
        )
        .catch(() => session.send({ type: "stage.offer", jobId: m.jobId }));
    });
    ws.on("message", (data) => {
      void session.onRaw(data.toString()).then(() => syncExecs(session));
    });
    ws.on("close", () => {
      session.closed();
      dropSession(session);
    });
    ws.on("error", () => session.closed());
  }

  // Tras cada mensaje: crear execs para instances nuevas del heartbeat.
  function syncExecs(session: ForgeSession): void {
    const pk = session.pubkey;
    if (!pk) return;
    for (const v of deps.registry.views()) {
      if (v.forgePubkey !== pk) continue;
      if (v.capability === "image") {
        if (!remoteImageExecs.has(v.forgeId)) {
          const ex = new TrackedImageExec(
            new RemoteImageExec({ channel: session, instanceId: v.forgeId, model: v.model }),
          );
          remoteImageExecs.set(v.forgeId, ex);
          instanceOwner.set(v.forgeId, session);
          attestImage(ex, v);
        }
      } else if (v.capability === "text") {
        if (!remoteExecs.has(v.forgeId)) {
          const ex = new TrackedExec(
            new RemoteForgeExec({
              channel: session,
              instanceId: v.forgeId,
              model: v.model,
              resident: () => deps.registry.reportOf(v.forgeId)?.hot ?? false,
              pool,
              stagePool,
              forgePubkey: pk,
              verify: deps.verify, // A4: stageSigs chequeadas contra el loan
            }),
          );
          remoteExecs.set(v.forgeId, ex);
          instanceOwner.set(v.forgeId, session);
          attestText(ex, v);
          lastAttest.set(v.forgeId, Date.now());
        } else if (!v.attested && Date.now() - (lastAttest.get(v.forgeId) ?? 0) > ATTEST_RETRY_MS) {
          const rep = deps.registry.reportOf(v.forgeId);
          if (rep?.pool !== undefined || rep?.pipeline !== undefined) {
            // Solo pooled/pipeline reintenta: "sin workers/stages" es
            // transient. Una instance normal que no pudo servir 4 tokens
            // está rota, no ocupada.
            lastAttest.set(v.forgeId, Date.now());
            attestText(remoteExecs.get(v.forgeId)!, v);
          }
        }
      }
    }
  }

  // Attestation v1 (ADR-0005): un job real chico por el canal — la instance
  // debe emitir tokens Y que el proof L0 verifique contra SU pubkey
  // registrada. Pasa = ruteable; falla/cuelga = queda fuera (visible en
  // /v1/forges con attested:false, jamás sirve requests).
  function attestText(exec: ForgeExec, v: ForgeView): void {
    void (async () => {
      try {
        const box: { p?: Proof } = {};
        let tokens = 0;
        for await (const c of exec.execute({
          jobId: `attest-${v.forgeId}-${Date.now()}`,
          model: v.model,
          prompt: "Reply with exactly: ok",
          options: { maxTokens: 4, temperature: 0 },
          onProof: (p) => {
            box.p = p;
          },
        })) {
          if (c.token) tokens++;
          if (c.done) break;
        }
        const pk = v.forgePubkey;
        if (tokens > 0 && pk && box.p && (await deps.verify(pk, box.p.resultHash, box.p.signature))) {
          deps.registry.attest(pk, v.forgeId);
        }
      } catch {
        // sin attestation — el filtro de routing la mantiene fuera
      }
    })();
  }

  // Imagen (S40): attestation REAL — un image.assign chico por el canal; el
  // resultado debe decodificar a imagen con dimensiones válidas. Más caro que
  // probe() (~una difusión) pero una vez por registro, y prueba el pipeline
  // completo — no solo que el socket respira.
  function attestImage(exec: ImageExec, v: ForgeView): void {
    void (async () => {
      try {
        const r = await exec.generateImage({
          jobId: `attest-${v.forgeId}-${Date.now()}`,
          model: v.model,
          prompt: "solid gray square",
          size: "512x512",
        });
        if (v.forgePubkey && imageDims(r.b64) !== null && r.b64.length > 1000) {
          deps.registry.attest(v.forgePubkey, v.forgeId);
        }
      } catch {
        // sin attestation — fuera de routing
      }
    })();
  }

  function dropSession(session: ForgeSession): void {
    if (session.pubkey) {
      sessions.delete(session.pubkey);
      // Coordinator muerto → sus workers prestados vuelven al pool (los
      // workers muertos se curan solos por evicción perezosa en acquire).
      pool.releaseForge(session.pubkey);
      stagePool.releaseForge(session.pubkey);
    }
    sockets.delete(session);
    for (const [id, owner] of instanceOwner) {
      if (owner === session) {
        instanceOwner.delete(id);
        remoteExecs.delete(id);
        remoteImageExecs.delete(id);
      }
    }
  }

  // Ping cada 5s → pong mide RTT real → registry.setRtt → ETR.
  const pingLoop = setInterval(() => {
    for (const s of sessions.values()) s.ping();
  }, 5_000);
  pingLoop.unref();

  // Expiry: sin heartbeat en TTL → la sesión muere y su socket se cierra.
  const expireLoop = setInterval(() => {
    for (const pk of deps.registry.expire()) {
      const s = sessions.get(pk);
      if (s) {
        s.closed();
        sockets.get(s)?.close(4004, "heartbeat timeout");
        dropSession(s);
      }
    }
  }, 5_000);
  expireLoop.unref();

  return {
    remoteExecs,
    remoteImageExecs,
    sessions,
    setDead: (instanceId, dead) => kill.setDead(instanceId, dead),
    stop() {
      clearInterval(pingLoop);
      clearInterval(expireLoop);
      for (const s of sessions.values()) {
        s.closed();
        // El socket también se cierra: en modo noServer wss.close() no toca
        // los upgrades — sin esto el daemon queda en handshake de cierre ~30s.
        sockets.get(s)?.close(4001, "gateway shutdown");
      }
      wss.close();
    },
  };
}
