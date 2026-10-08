// S47 — transporte coordinator→stage sobre TCP JSON-lines (spec 018).
// Una conexión por endpoint; correlation por sessionId+seq (un step
// outstanding por sesión — Petals: el pipeline es secuencial por diseño).
// Frames estrictos via decodeStage/decodeCoord — un frame malo cierra la
// conexión (misma disciplina que el canal gateway: input remoto jamás throw).
import { connect, type Socket } from "node:net";
import { decodeCoord, decodeStage, encodeStage, type CoordMsg, type StageMsg, type StageOutMsg, type StageStepMsg } from "@weaver/forge-net";

export type StageSessionInfo = {
  jobId: string;
  sessionId: string;
  model: string;
  blocks: [number, number];
  kvLenHint?: number;
};

// Canal coordinator→stage: lo que el PipelineExec necesita — nada más.
export type StageTransport = {
  open(s: StageSessionInfo): Promise<void>;
  step(s: Omit<StageStepMsg, "type">): Promise<Pick<StageOutMsg, "payload" | "sig">>;
  close(sessionId: string): void;
  dispose(): void;
  readonly alive: boolean;
  onDead?(cb: (err: Error) => void): void;
};

export type StageDial = (endpoint: string) => StageTransport;

// TCP real: net.connect al endpoint del stage + líneas JSON estrictas.
export function tcpStageDial(endpoint: string, timeoutMs = 10_000): StageTransport {
  const m = /^(.+):(\d+)$/.exec(endpoint);
  if (!m) throw new Error(`endpoint inválido: ${endpoint}`);
  const host = m[1].replace(/^\[|\]$/g, "");
  const port = Number(m[2]);
  const sock = connect({ host, port });
  let alive = true;
  let deadErr: Error | null = null;
  const deadCbs = new Set<(e: Error) => void>();
  const pending = new Map<string, { res: (m: StageMsg) => void; rej: (e: Error) => void }>();
  let buf = "";

  const die = (e: Error) => {
    if (!alive) return;
    alive = false;
    deadErr = e;
    for (const p of pending.values()) p.rej(e);
    pending.clear();
    for (const cb of deadCbs) cb(e);
  };

  sock.setNoDelay(true);
  sock.on("data", (d) => {
    buf += d.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = decodeStage(line);
      if (!msg) {
        die(new Error(`stage ${endpoint}: frame inválido`));
        sock.destroy();
        return;
      }
      // stage.out casa por sessionId; ack por sessionId; fail por sessionId.
      const p = pending.get(msg.sessionId);
      if (p) {
        pending.delete(msg.sessionId);
        if (msg.type === "stage.fail") p.rej(new Error(msg.error));
        else p.res(msg);
      }
    }
  });
  sock.on("error", (e) => die(e));
  sock.on("close", () => die(new Error(`stage ${endpoint}: conexión cerrada`)));

  const send = (msg: CoordMsg) => {
    if (!alive) throw deadErr ?? new Error("transport muerto");
    sock.write(encodeStage(msg) + "\n");
  };

  const waitConnect = new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error(`stage ${endpoint}: connect timeout`)), timeoutMs);
    sock.once("connect", () => {
      clearTimeout(t);
      res();
    });
    sock.once("error", (e) => {
      clearTimeout(t);
      rej(e);
    });
  });

  return {
    get alive() {
      return alive;
    },
    onDead(cb) {
      deadCbs.add(cb);
    },
    async open(s) {
      await waitConnect;
      const p = new Promise<StageMsg>((res, rej) => pending.set(s.sessionId, { res, rej }));
      send({ type: "stage.open", ...s });
      const r = await p;
      if (r.type !== "stage.ack") throw new Error(`stage ${endpoint}: open sin ack`);
    },
    async step(s) {
      const p = new Promise<StageMsg>((res, rej) => pending.set(s.sessionId, { res, rej }));
      send({ type: "stage.step", ...s });
      const r = await p;
      if (r.type !== "stage.out") throw new Error(`stage ${endpoint}: step sin out`);
      return { payload: r.payload, ...(r.sig ? { sig: r.sig } : {}) };
    },
    close(sessionId) {
      try {
        send({ type: "stage.close", sessionId });
      } catch {
        /* ya muerto */
      }
    },
    dispose() {
      sock.destroy();
      die(new Error("disposed"));
    },
  };
}

// ---------- lado stage (server) ----------

// Lo que el stage-worker implementa: KV por sesión + forward por step.
export type StageCompute = {
  open(s: StageSessionInfo): Promise<void> | void;
  step(s: Omit<StageStepMsg, "type">): Promise<{ payload: string; sig?: string }> | { payload: string; sig?: string };
  close(sessionId: string): void;
  sessions(): number;
};

export function createStageSocket(
  sock: Socket,
  compute: StageCompute,
): void {
  let buf = "";
  const sessionIds = new Set<string>(); // sesiones de ESTE socket → close las libera
  sock.setNoDelay(true);
  const send = (m: StageMsg) => sock.write(encodeStage(m) + "\n");
  sock.on("data", (d) => {
    buf += d.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = decodeCoord(line);
      if (!msg) {
        sock.destroy();
        return;
      }
      void handle(msg);
    }
  });
  sock.on("error", () => sock.destroy());
  sock.on("close", () => {
    // Socket muerto con sesiones abiertas: el coordinator no va a mandar
    // stage.close (su canal también murió) — liberar el KV acá o queda
    // reservado para siempre (leak real de sesiones zombie).
    for (const id of sessionIds) compute.close(id);
  });

  async function handle(msg: CoordMsg): Promise<void> {
    try {
      switch (msg.type) {
        case "stage.open":
          await compute.open(msg);
          sessionIds.add(msg.sessionId);
          send({ type: "stage.ack", sessionId: msg.sessionId });
          break;
        case "stage.step": {
          const r = await compute.step(msg);
          send({ type: "stage.out", sessionId: msg.sessionId, seq: msg.seq, payload: r.payload, ...(r.sig ? { sig: r.sig } : {}) });
          break;
        }
        case "stage.close":
          sessionIds.delete(msg.sessionId);
          compute.close(msg.sessionId);
          break;
      }
    } catch (e) {
      const sid = "sessionId" in msg ? (msg as { sessionId: string }).sessionId : "?";
      send({ type: "stage.fail", sessionId: sid, error: e instanceof Error ? e.message : String(e) });
    }
  }
}
