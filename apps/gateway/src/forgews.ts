// S31/S32 — adapter WS: sockets reales → ForgeSession (protocolo puro en
// forge-net). El forge marca outbound a /v1/forge/ws (mining-pool): auth con
// nonce firmado, heartbeats cada ~5s, jobs bajan por el mismo canal.
// Vive en serve.ts (composition root) — createApp nunca ve sockets, los tests
// de rutas siguen usando app.request.
import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  ForgeSession,
  RemoteForgeExec,
  RemoteImageExec,
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
  stop(): void;
};

export function attachForgeWS(
  server: Server,
  deps: { registry: ForgeRegistry; nonces: NonceStore; verify: VerifyFn },
): ForgeWS {
  const wss = new WebSocketServer({ noServer: true });
  const sessions = new Map<string, ForgeSession>();
  const sockets = new Map<ForgeSession, WebSocket>();
  const remoteExecs = new Map<string, ForgeExec>();
  const remoteImageExecs = new Map<string, ImageExec>();
  const instanceOwner = new Map<string, ForgeSession>();

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
      } else if (!remoteExecs.has(v.forgeId)) {
        const ex = new TrackedExec(
          new RemoteForgeExec({
            channel: session,
            instanceId: v.forgeId,
            model: v.model,
            resident: () => deps.registry.reportOf(v.forgeId)?.hot ?? false,
          }),
        );
        remoteExecs.set(v.forgeId, ex);
        instanceOwner.set(v.forgeId, session);
        attestText(ex, v);
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
        if (tokens > 0 && pk && box.p && deps.verify(pk, box.p.resultHash, box.p.signature)) {
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
    if (session.pubkey) sessions.delete(session.pubkey);
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
    stop() {
      clearInterval(pingLoop);
      clearInterval(expireLoop);
      for (const s of sessions.values()) s.closed();
      wss.close();
    },
  };
}
