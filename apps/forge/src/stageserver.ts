// S47 — stage-server: el proceso que un stage-worker expone al mundo.
// TCP JSON-lines (stagetransport) sobre un StageCompute inyectable —
// prod: block-runner real (fase B); stage-sim: SimStageCompute. El server
// NO conoce pesos ni modelos: solo sesiones + bytes.
import { createServer, type Server } from "node:net";
import { createStageRouter, createStageSocket, type StageCompute } from "./stagetransport.ts";

export type StageServer = {
  readonly alive: boolean;
  readonly port: number;
  sessions(): number;
  close(): void;
};

// listen() es async — el caller hace `await srv.ready` antes de heartbeatear
// alive (un bind fallido reporta muerto, no crashea el forge).
export function startStageServer(opts: {
  host?: string;
  port: number;
  compute: StageCompute;
  onError?: (e: Error) => void;
}): StageServer & { ready: Promise<void> } {
  let alive = false;
  const sockets = new Set<import("node:net").Socket>();
  // Router compartido: las sesiones stage reciben stage.fwd por sockets que
  // NO son el del coordinator (data plane B2) — la ruta es del server.
  const router = createStageRouter();
  const srv: Server = createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    createStageSocket(sock, opts.compute, router);
  });
  const ready = new Promise<void>((res, rej) => {
    srv.once("error", (e) => {
      opts.onError?.(e);
      rej(e);
    });
    srv.listen(opts.port, opts.host ?? "0.0.0.0", () => {
      alive = true;
      res();
    });
  });
  srv.on("error", (e) => opts.onError?.(e));
  return {
    ready,
    get alive() {
      return alive && srv.listening;
    },
    get port() {
      const a = srv.address();
      return typeof a === "object" && a ? a.port : opts.port;
    },
    sessions: () => opts.compute.sessions(),
    close() {
      alive = false;
      // close() real de un server caído: los sockets establecidos también
      // mueren — sin esto el coordinator queda dialado a un fantasma y el
      // heal nunca dispara (server.close solo deja de aceptar nuevos).
      for (const s of sockets) s.destroy();
      srv.close();
    },
  };
}
