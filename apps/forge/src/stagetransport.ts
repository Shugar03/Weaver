// S47 — transporte coordinator→stage sobre TCP JSON-lines (spec 018).
// Una conexión por endpoint; correlation por sessionId+seq (un step
// outstanding por sesión — Petals: el pipeline es secuencial por diseño).
// Frames estrictos via decodeStage/decodeCoord — un frame malo cierra la
// conexión (misma disciplina que el canal gateway: input remoto jamás throw).
// B2: data plane directo — stage.fwd va stage→stage; el coordinator solo
// inyecta en s1 (inject) y espera el out de sN (expectOut) por el socket
// dueño de la sesión. Relay mode = sin next: idéntico al comportamiento S47.
import { connect, type Socket } from "node:net";
import { decodeCoord, decodeStage, encodeStage, type CoordMsg, type StageFwdMsg, type StageMsg, type StageOutMsg, type StageStepMsg } from "@weaver/forge-net";

export type StageSessionInfo = {
  jobId: string;
  sessionId: string;
  model: string;
  blocks: [number, number];
  kvLenHint?: number;
  // B1 WAN auth: capability minteada por el daemon del worker + pubkey del
  // coordinator que la presenta. El compute con auth la exige.
  token?: string;
  coordPubkey?: string;
  // B2 direct: próximo hop — el stage forwardea su output ahí con las
  // credenciales de la sesión destino (courier, no puede mintearlas).
  next?: { endpoint: string; sessionId: string; token?: string; coordPubkey?: string };
};

// Canal coordinator→stage: lo que el PipelineExec necesita — nada más.
// close() devuelve el close-ack: {sig, inChain, outChain} = firma del stage
// sobre su cadena de activaciones + half-chains de frontera (B2). Transporte
// muerto/sin ack → {} — la firma es evidencia, no requisito para cerrar.
export type StageTransport = {
  open(s: StageSessionInfo): Promise<void>;
  step(s: Omit<StageStepMsg, "type">): Promise<Pick<StageOutMsg, "payload" | "sig">>;
  // B2 direct: inyecta un step sin esperar out (s1 forwardea, no responde)
  // y expectOut espera el stage.out que sN manda por su socket dueño.
  inject(s: Omit<StageStepMsg, "type">): void;
  expectOut(sessionId: string, seq: number): Promise<Pick<StageOutMsg, "payload" | "sig">>;
  // B3 heal por stage-cache: pide al stage VIVO reenviar sus outputs
  // cacheados al target (el reemplazo del stage muerto).
  replay(sessionId: string, uptoSeq: number, target: { endpoint: string; sessionId: string; token?: string; coordPubkey?: string }): Promise<void>;
  // B3: el coordinator re-inyecta activaciones absorb (heal de s1 — no hay
  // stage anterior que tenga el cache) y redirige el next de un stage vivo
  // hacia el reemplazo (el tramo muerto sale del data plane).
  injectFwd(m: Omit<StageFwdMsg, "type">): void;
  repoint(sessionId: string, next: { endpoint: string; sessionId: string; token?: string; coordPubkey?: string }): Promise<void>;
  close(sessionId: string): Promise<{ sig?: string; inChain?: string; outChain?: string }>;
  dispose(): void;
  readonly alive: boolean;
  onDead?(cb: (err: Error) => void): void;
  // B2: stage.fail/report de sesiones sin step pendiente (modo directo —
  // el coordinator no tiene pending en los sockets medios, los eventos
  // llegan por onEvent o se pierden silenciosamente).
  onEvent?(cb: (m: StageMsg) => void): void;
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
  const eventCbs = new Set<(m: StageMsg) => void>();
  const pending = new Map<string, { res: (m: StageMsg) => void; rej: (e: Error) => void }>();
  // B2: stage.out puede llegar ANTES de que expectOut registre su pending
  // (loopback: inject→fwd→out completa en <1ms). Sin buffer se pierde y el
  // await cuelga. Los outs sin pending se encolan por sessionId.
  const outBuf = new Map<string, StageOutMsg[]>();
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
      } else if (msg.type === "stage.out") {
        const q = outBuf.get(msg.sessionId);
        if (q) q.push(msg);
        else outBuf.set(msg.sessionId, [msg]);
      } else {
        // B2: report/fail sin pending — el pipeline directo los escucha
        // via onEvent (blame de stages medios, progreso, fail temprano).
        for (const cb of eventCbs) cb(msg);
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
    inject(s) {
      send({ type: "stage.step", ...s });
    },
    async expectOut(sessionId, seq) {
      // Un out buffered (llegó antes del await) resuelve sin ir a pending.
      const buffered = outBuf.get(sessionId);
      const bi = buffered?.findIndex((m) => m.seq === seq) ?? -1;
      const r = buffered && bi >= 0
        ? buffered.splice(bi, 1)[0]
        : await new Promise<StageMsg>((res, rej) => pending.set(sessionId, { res, rej }));
      if (r.type !== "stage.out") throw new Error(`stage ${endpoint}: expectOut seq ${seq} → ${r.type}`);
      if (r.seq !== seq) throw new Error(`stage ${endpoint}: out seq ${r.seq} ≠ esperado ${seq}`);
      return { payload: r.payload, ...(r.sig ? { sig: r.sig } : {}) };
    },
    async replay(sessionId, uptoSeq, target) {
      const p = new Promise<StageMsg>((res, rej) => pending.set(sessionId, { res, rej }));
      send({ type: "stage.replay", sessionId, uptoSeq, target });
      const r = await p;
      if (r.type !== "stage.ack") throw new Error(`stage ${endpoint}: replay sin ack`);
    },
    injectFwd(m) {
      send({ type: "stage.fwd", ...m });
    },
    async repoint(sessionId, next) {
      const p = new Promise<StageMsg>((res, rej) => pending.set(sessionId, { res, rej }));
      send({ type: "stage.repoint", sessionId, next });
      const r = await p;
      if (r.type !== "stage.ack") throw new Error(`stage ${endpoint}: repoint sin ack`);
    },
    async close(sessionId) {
      try {
        const p = new Promise<StageMsg>((res, rej) => pending.set(sessionId, { res, rej }));
        send({ type: "stage.close", sessionId });
        const r = await Promise.race([
          p,
          new Promise<StageMsg>((_r, rej) => setTimeout(() => rej(new Error("close-ack timeout")), 5_000).unref()),
        ]);
        return r.type === "stage.ack"
          ? {
              ...(r.sig ? { sig: r.sig } : {}),
              ...(r.inChain ? { inChain: r.inChain } : {}),
              ...(r.outChain ? { outChain: r.outChain } : {}),
            }
          : {};
      } catch {
        return {}; // muerto o sin ack — la firma es evidencia, no requisito
      }
    },
    onEvent(cb) {
      eventCbs.add(cb);
    },
    dispose() {
      sock.destroy();
      die(new Error("disposed"));
    },
  };
}

// ---------- lado stage (server) ----------

// Lo que el stage-worker implementa: KV por sesión + forward por step.
// close() devuelve {sig, inChain, outChain} = la firma del tramo (A4) +
// los half-chains de frontera (B2). Sin signer (substrate viejo): {}.
export type StageCompute = {
  open(s: StageSessionInfo): Promise<void> | void;
  step(s: Omit<StageStepMsg, "type">): Promise<{ payload: string; sig?: string }> | { payload: string; sig?: string };
  close(sessionId: string): Promise<{ sig?: string; inChain?: string; outChain?: string } | void> | { sig?: string; inChain?: string; outChain?: string } | void;
  sessions(): number;
};

// B2 — router por SERVER (compartido entre sockets): una sesión stage
// recibe frames por DOS canales — el socket dueño (quien la abrió:
// coordinator) y sockets de data plane (fwd del stage anterior / replay).
// El dueño es donde van stage.out/stage.report/stage.fail: el coordinator
// sigue siendo el destino del resultado aunque el cómputo llegue de otro.
type StageRoute = {
  owner: Socket;
  token?: string; // creds del open — un fwd debe igualarlas (courier-auth)
  coordPubkey?: string;
  next?: { endpoint: string; sessionId: string; token?: string; coordPubkey?: string };
  outCache: Map<number, { shape: [number, number]; dtype: "f16" | "f32" | "q8"; payload: string }>;
  seqs: Set<number>; // dedup — un seq reenviado no re-corre (KV doble-append)
  fwdSock?: Socket; // socket saliente al next (lazy-connect)
};

export type StageRouter = {
  routes: Map<string, StageRoute>;
  dial(endpoint: string): Socket; // inyectable en tests; prod = net.connect
  release(sessionId: string): void;
};

// El router es lo que comparten TODOS los sockets del server (un stage.fwd
// puede llegar por cualquier conexión — la sesión no es del socket, es del
// server). dial vive acá porque los forwards/replays los hace el ROUTER.
export function createStageRouter(dial: (endpoint: string) => Socket = defaultDial): StageRouter {
  const routes = new Map<string, StageRoute>();
  return {
    routes,
    dial,
    release(sessionId) {
      const r = routes.get(sessionId);
      r?.fwdSock?.destroy();
      routes.delete(sessionId);
    },
  };
}

const defaultDial = (endpoint: string): Socket => {
  const m = /^(.+):(\d+)$/.exec(endpoint);
  if (!m) throw new Error(`endpoint inválido: ${endpoint}`);
  return connect({ host: m[1].replace(/^\[|\]$/g, ""), port: Number(m[2]) });
};

const fwdFrame = (to: { sessionId: string; token?: string; coordPubkey?: string }, src: { seq: number; shape: [number, number]; dtype: "f16" | "f32" | "q8"; payload: string }, absorb?: boolean): StageFwdMsg => ({
  type: "stage.fwd",
  sessionId: to.sessionId,
  seq: src.seq,
  shape: src.shape,
  dtype: src.dtype,
  payload: src.payload,
  ...(to.token ? { token: to.token } : {}),
  ...(to.coordPubkey ? { coordPubkey: to.coordPubkey } : {}),
  ...(absorb ? { absorb: true } : {}),
});

// Cuántas activaciones retiene el cache de replay por sesión — acota
// memoria sin cortar jobs reales (maxTokens del exec es << esto).
const OUT_CACHE_MAX = 8192;

export function createStageSocket(
  sock: Socket,
  compute: StageCompute,
  router: StageRouter = createStageRouter(),
): void {
  let buf = "";
  const owned = new Set<string>(); // sesiones abiertas por ESTE socket
  sock.setNoDelay(true);
  const sendTo = (s: Socket, m: StageMsg) => s.write(encodeStage(m) + "\n");
  const send = (m: StageMsg) => sendTo(sock, m);
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
    // reservado para siempre (leak real de sesiones zombie). Solo las
    // sesiones de las que este socket es DUEÑO — las fwd son efímeras.
    for (const id of owned) {
      router.release(id);
      void compute.close(id);
    }
  });

  // Post-compute: el output va al next (fwd directo + report al dueño) o
  // al dueño (stage.out). "Routed-away" ⇒ el dueño recibe report por seq —
  // un mensaje por paso por sesión, siempre: blame + progreso anclados.
  function deliver(route: StageRoute, sessionId: string, seq: number, out: { shape: [number, number]; dtype: "f16" | "f32" | "q8"; payload: string; sig?: string }): void {
    route.outCache.set(seq, { shape: out.shape, dtype: out.dtype, payload: out.payload });
    if (route.outCache.size > OUT_CACHE_MAX) {
      const oldest = route.outCache.keys().next().value;
      if (oldest !== undefined) route.outCache.delete(oldest);
    }
    if (route.next) {
      try {
        if (!route.fwdSock || route.fwdSock.destroyed) {
          // Capturamos el next de ESTE socket: un repoint posterior cambia
          // route.next — el blame corresponde al destino que falló, no al
          // reemplazo inocente que vino después.
          const next0 = route.next;
          route.fwdSock = router.dial(next0.endpoint);
          // Un socket sin 'error' handler crashea el proceso al primer
          // ECONNRESET (next-stage muerto mid-forward). El error va al
          // owner como fail — el coordinator heal-ea, no morimos nosotros.
          route.fwdSock.on("error", (e) => {
            sendTo(route.owner, { type: "stage.fail", sessionId, error: `fwd a ${next0.endpoint}: ${e.message}`, blame: next0.sessionId });
          });
        }
        route.fwdSock.write(encodeStage(fwdFrame(route.next, { seq, ...out })) + "\n");
      } catch (e) {
        sendTo(route.owner, { type: "stage.fail", sessionId, error: `fwd a ${route.next.endpoint}: ${e instanceof Error ? e.message : e}`, blame: route.next.sessionId });
        return;
      }
      sendTo(route.owner, { type: "stage.report", sessionId, seq });
    } else {
      sendTo(route.owner, { type: "stage.out", sessionId, seq, payload: out.payload, ...(out.sig ? { sig: out.sig } : {}) });
    }
  }

  async function runStep(route: StageRoute, msg: { sessionId: string; seq: number; shape: [number, number]; dtype: "f16" | "f32" | "q8"; payload: string }): Promise<void> {
    // Dedup con redelivery: un seq ya procesado NO se recomputa (doble-append
    // de KV corrompería el estado) — pero SÍ se reenvía su output cacheado.
    // Sin esto el heal-directo se rompe: el coordinator re-inyecta el token
    // en vuelo en s1 y la onda debe ATRAVESAR los stages sanos (cada uno
    // redeliver su cache) hasta el reemplazo que computa de verdad.
    if (route.seqs.has(msg.seq)) {
      const cached = route.outCache.get(msg.seq);
      if (cached) deliver(route, msg.sessionId, msg.seq, cached);
      return;
    }
    const r = await compute.step(msg);
    route.seqs.add(msg.seq);
    deliver(route, msg.sessionId, msg.seq, { shape: msg.shape, dtype: msg.dtype, payload: r.payload, ...(r.sig ? { sig: r.sig } : {}) });
  }

  async function handle(msg: CoordMsg): Promise<void> {
    const sid = "sessionId" in msg ? msg.sessionId : "?";
    const route = router.routes.get(sid);
    // Errores van al dueño si la ruta existe (el coordinator es quien heal);
    // si no hay ruta, al socket que trajo el frame.
    const failTo = (e: unknown) =>
      sendTo(route?.owner ?? sock, { type: "stage.fail", sessionId: sid, error: e instanceof Error ? e.message : String(e) });
    try {
      switch (msg.type) {
        case "stage.open":
          await compute.open(msg);
          owned.add(msg.sessionId);
          router.routes.set(msg.sessionId, {
            owner: sock,
            ...(msg.token ? { token: msg.token } : {}),
            ...(msg.coordPubkey ? { coordPubkey: msg.coordPubkey } : {}),
            ...(msg.next ? { next: msg.next } : {}),
            outCache: new Map(),
            seqs: new Set(),
          });
          send({ type: "stage.ack", sessionId: msg.sessionId });
          break;
        case "stage.step": {
          // Solo el dueño inyecta por step (modo relay/directo: coord→s1).
          if (!route || route.owner !== sock) throw new Error("step: sesión ajena o inexistente");
          await runStep(route, msg);
          break;
        }
        case "stage.fwd": {
          // Courier-auth: las credenciales del fwd deben IGUALAR las del
          // open de la sesión — mismas capability, mismo derecho. Un
          // activador cualquiera en WAN no puede empujar activaciones.
          if (!route) throw new Error("fwd: sesión inexistente");
          if ((msg.token ?? undefined) !== route.token || (msg.coordPubkey ?? undefined) !== route.coordPubkey) {
            throw new Error("fwd: credenciales no coinciden con la sesión");
          }
          if (msg.absorb) {
            if (route.seqs.has(msg.seq)) break;
            await compute.step(msg);
            route.seqs.add(msg.seq);
            // absorb: KV reconstruido, nada se propaga (los vecinos ya lo
            // procesaron — el heal no inunda la cadena con duplicados).
            break;
          }
          await runStep(route, msg);
          break;
        }
        case "stage.replay": {
          if (!route || route.owner !== sock) throw new Error("replay: sesión ajena o inexistente");
          const seqs = [...route.outCache.keys()].filter((n) => msg.uptoSeq === undefined || n <= msg.uptoSeq).sort((a, b) => a - b);
          await new Promise<void>((res, rej) => {
            const sock2 = router.dial(msg.target.endpoint);
            sock2.once("connect", () => {
              for (const n of seqs) {
                const o = route.outCache.get(n);
                if (o) sock2.write(encodeStage(fwdFrame(msg.target, { seq: n, ...o }, true)) + "\n");
              }
              sock2.end(() => res()); // flush antes de cerrar
            });
            sock2.once("error", (e) => rej(e));
          });
          send({ type: "stage.ack", sessionId: msg.sessionId });
          break;
        }
        case "stage.repoint": {
          // Solo el dueño redirige — un courier no puede desviar la cadena.
          if (!route || route.owner !== sock) throw new Error("repoint: sesión ajena o inexistente");
          route.fwdSock?.destroy();
          route.fwdSock = undefined;
          route.next = msg.next;
          send({ type: "stage.ack", sessionId: msg.sessionId });
          break;
        }
        case "stage.close": {
          owned.delete(msg.sessionId);
          router.release(msg.sessionId);
          const r = await compute.close(msg.sessionId);
          send({
            type: "stage.ack",
            sessionId: msg.sessionId,
            ...(r?.sig ? { sig: r.sig } : {}),
            ...(r && "inChain" in r && r.inChain ? { inChain: r.inChain } : {}),
            ...(r && "outChain" in r && r.outChain ? { outChain: r.outChain } : {}),
          });
          break;
        }
      }
    } catch (e) {
      failTo(e);
    }
  }
}
