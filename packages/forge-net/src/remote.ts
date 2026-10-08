// S31 — RemoteForgeExec/RemoteImageExec: los puertos de siempre sobre el
// canal WS. El transporte es un adapter más: RoutedExec, failover, breaker
// y TrackedExec funcionan igual que con execs locales (ADR-0005).
//
// Semántica de fallo preservada:
// - assign sin ack / primer-token timeout → throw ANTES de emitir → el
//   failover reintenta en otro forge (pre-token).
// - job.fail midStream o desconexión con job en vuelo → propaga explícito,
//   jamás [DONE] falso ni retry silencioso.
import { createHash } from "node:crypto";
import { commitProof, promptHashOf } from "@weaver/forge-exec";
import type {
  ExecRequest,
  ForgeExec,
  ImageExec,
  ImageRequest,
  ImageResult,
  StageSig,
  StreamChunk,
} from "@weaver/forge-exec";
import type { ForgeMsg, GatewayMsg, JobDoneMsg } from "./protocol.ts";
import type { ForgePool } from "./pool.ts";
import type { StagePool } from "./stagepool.ts";
import { stageSigPreimage, stageSigPreimageV2 } from "./stageproto.ts";
import type { VerifyFn } from "./session.ts";

// Canal abstracto — testeable con un fake duplex, sin socket real.
// ws-server (gateway) y client (daemon) lo implementan sobre su transporte.
export interface ForgeChannel {
  send(msg: GatewayMsg): void;
  // cb recibe SOLO mensajes daemon→gateway post-auth. Devuelve unsubscribe.
  onMessage(cb: (msg: ForgeMsg) => void): () => void;
  // Dispara una vez cuando el canal muere (socket close, kick, auth fail).
  onClose(cb: () => void): () => void;
  isAlive(): boolean;
}

// Lado daemon: el espejo — envía ForgeMsg, recibe GatewayMsg.
export interface DaemonChannel {
  send(msg: ForgeMsg): void;
  onMessage(cb: (msg: GatewayMsg) => void): () => void;
  onClose(cb: () => void): () => void;
  isAlive(): boolean;
  // Cierre iniciado por el daemon (stop) — onClose dispara igual. Sin él el
  // socket quedaba abierto tras daemon.stop(): leak de handle en tests y un
  // forge "parado" seguía conectado en prod.
  close?(): void;
}

const withTimeout = <T>(p: Promise<T>, ms: number, msg: string): Promise<T> =>
  new Promise<T>((res, rej) => {
    const t = setTimeout(() => rej(new Error(msg)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        res(v);
      },
      (e) => {
        clearTimeout(t);
        rej(e);
      },
    );
  });

export class RemoteForgeExec implements ForgeExec {
  readonly forgeId: string; // instanceId — único por slot del forge
  readonly model: string;
  private readonly channel: ForgeChannel;
  private readonly ackTimeoutMs: number;
  private readonly firstTokenTimeoutMs: number;
  private readonly pooledFirstTokenMs: number;
  private readonly isResident?: () => boolean;
  private readonly pool?: ForgePool;
  private readonly stagePool?: StagePool;
  private readonly forgePubkey: string;
  private readonly verifyFn?: VerifyFn;
  // B4 (spec 017): la instance declaró capacidad pooled (pool.needs /
  // pipeline en su report). El gate se consulta por job — la declaración
  // puede cambiar entre heartbeats y el consent es por request.
  private readonly isPooled?: () => boolean;

  constructor(opts: {
    channel: ForgeChannel;
    instanceId: string;
    model: string;
    ackTimeoutMs?: number;
    firstTokenTimeoutMs?: number;
    // S46: boot pooled — spawnear llama-server --rpc y cargar el GGUF puede
    // tardar minutos (70B+ en disco). El timeout normal de primer token
    // mataría un cold start SANO → el job moría healthy y el failover
    // penalizaba un forge que solo estaba cargando. Default 300s.
    pooledFirstTokenMs?: number;
    resident?: () => boolean;
    pool?: ForgePool;
    stagePool?: StagePool;
    forgePubkey?: string;
    // S47 A4: verifica las firmas de stage contra el loan (endpoint→pubkey).
    // Sin verify las stageSigs se descartan — evidencia sin chequear no se
    // reenvía como si fuera verificada.
    verify?: VerifyFn;
    pooled?: () => boolean;
  }) {
    this.channel = opts.channel;
    this.forgeId = opts.instanceId;
    this.model = opts.model;
    this.ackTimeoutMs = opts.ackTimeoutMs ?? 3_000;
    this.firstTokenTimeoutMs = opts.firstTokenTimeoutMs ?? 60_000;
    this.pooledFirstTokenMs = opts.pooledFirstTokenMs ?? 300_000;
    this.isResident = opts.resident;
    this.pool = opts.pool;
    this.stagePool = opts.stagePool;
    this.forgePubkey = opts.forgePubkey ?? "";
    this.verifyFn = opts.verify;
    this.isPooled = opts.pooled;
  }

  probe(): Promise<boolean> {
    return Promise.resolve(this.channel.isAlive());
  }

  resident(): Promise<boolean> {
    return Promise.resolve(this.isResident?.() ?? true);
  }

  // Cierre de un job.done del wire: mismos chequeos de siempre (contenido,
  // proof hash, sig sana) + verificación de stageSigs contra el loan.
  private async finishDone(
    m: JobDoneMsg,
    req: ExecRequest,
    served: ReturnType<typeof createHash>,
    servedChunks: number,
    queue: (StreamChunk | { err: Error })[],
    wakeUp: () => void,
    pooled: boolean,
  ): Promise<void> {
    const hasContent = servedChunks > 0 || Boolean(m.toolCalls && m.toolCalls.length > 0);
    if (!hasContent) {
      throw new Error(`forge ${this.forgeId}: output vacío — cero chunks servidos no generan proof`);
    }
    // Proof L0 del wire — el gateway NO re-firma; el recibo es del forge.
    // Commitment moderno (promptHash presente): resultHash =
    // sha256(promptHash‖outputHash) y el promptHash debe matchear el
    // input que ESTE gateway despachó. Legacy: resultHash=outputHash.
    const declared = Buffer.from(m.resultHash, "hex");
    const servedOut = served.digest();
    const proofOk = m.promptHash
      ? promptHashOf({
            model: req.model,
            prompt: req.prompt,
            ...(req.messages ? { messages: req.messages } : {}),
            ...(req.resume ? { resume: req.resume.prefix } : {}),
          }).equals(Buffer.from(m.promptHash, "hex")) &&
        commitProof(Buffer.from(m.promptHash, "hex"), servedOut).equals(declared)
      : servedOut.equals(declared);
    if (!proofOk) {
      throw new Error(`forge ${this.forgeId}: proof hash mismatch — el recibo no ata al input/output servido`);
    }
    // La firma también se sanea acá: un hex malformado produce un
    // buffer de longitud rara que el contrato rechaza on-chain —
    // mejor fallar antes que pagar el gas de un release inválido.
    // Válidas: 64B ed25519 (stellar) o 65B secp256k1 (evm).
    const sigBytes = Buffer.from(m.signature, "hex");
    if (sigBytes.length !== 64 && sigBytes.length !== 65) {
      throw new Error(`forge ${this.forgeId}: firma malformada (${sigBytes.length}B)`);
    }
    // S47 A4: stageSigs — cada entrada debe estar en el loan de ESTE job y
    // su firma verificar contra el pubkey del instance asignado. Las que no
    // verifican quedan fuera (y el firmante recibe strike — evidencia de
    // trampa o stage roto).
    const stageSigs = await this.verifyStageSigs(req.jobId, m.stageSigs);
    req.onProof?.({
      forgeId: this.forgeId,
      resultHash: declared,
      signature: sigBytes,
      ...(m.promptHash ? { promptHash: Buffer.from(m.promptHash, "hex"), outputHash: servedOut } : {}),
      ...(stageSigs ? { stageSigs } : {}),
      // B4: el receipt declara si el cómputo tocó capacidad prestada —
      // transparencia post-hoc, no solo consent a priori.
      ...(pooled ? { pooled: true } : {}),
    });
    queue.push({
      token: "",
      done: true,
      // genTokens MEDIDO: los chunks que relayeamos (atados al hash
      // verificado), no el conteo que el forge declara — su stats
      // declarativo puede inflar el pago; el nuestro no.
      stats: { ...(m.stats ?? {}), genTokens: servedChunks },
      ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}),
      ...(stageSigs ? { stageSigs } : {}),
    });
    wakeUp();
  }

  // Una stageSig es válida si: (a) su endpoint+blocks está en la cadena que
  // ESTE loan asignó, y (b) sig verifica contra el pubkey del instance — la
  // firma ata sha256(jobId:sessionId:chain) que stage y coordinator
  // computaron sobre el mismo tráfico. Endpoint ajeno al loan → no
  // atribuible; firma mala → strike al firmante.
  private async verifyStageSigs(jobId: string, sigs: StageSig[] | undefined): Promise<StageSig[] | undefined> {
    if (!sigs?.length || !this.stagePool || !this.verifyFn) return undefined;
    const loan = this.stagePool.chainOf(jobId);
    if (!loan?.length) return undefined;
    const out: StageSig[] = [];
    for (const s of sigs) {
      const e = loan.find((x) => x.endpoint === s.endpoint && x.blocks[0] === s.blocks[0] && x.blocks[1] === s.blocks[1]);
      if (!e) continue;
      // v2 (B2): si la entrada trae par in/out, la firma ata
      // sha256(jobId:sid:in:out); v1 legacy ata sha256(jobId:sid:chain).
      const pre =
        s.inChain && s.outChain
          ? stageSigPreimageV2(jobId, s.sessionId, s.inChain, s.outChain)
          : s.chain
            ? stageSigPreimage(jobId, s.sessionId, s.chain)
            : null;
      if (!pre) continue;
      // VerifyFn puede ser sync (ed25519) — Promise.resolve unifica y un
      // throw de verify = firma inválida, nunca crash del handler.
      const ok = await Promise.resolve(
        this.verifyFn(e.forgePubkey, pre, Buffer.from(s.sig, "hex")),
      ).catch(() => false);
      if (ok) out.push(s);
      else this.stagePool.strikeWorker(jobId, s.endpoint);
    }
    // Cross-check de frontera (B2): ordenadas por tramo, outChain_K debe
    // igualar inChain_K+1 — una activación tampered/perdida en el hop
    // rompe la convergencia. Simétrico: no se sabe cuál mintió → ambas
    // entradas se descartan y ambos stages toman strike.
    const byBlocks = out.slice().sort((a, b) => a.blocks[0] - b.blocks[0]);
    const bad = new Set<StageSig>();
    for (let i = 0; i + 1 < byBlocks.length; i++) {
      const a = byBlocks[i];
      const b = byBlocks[i + 1];
      if (a.outChain && b.inChain && a.outChain !== b.inChain) {
        bad.add(a);
        bad.add(b);
      }
    }
    if (bad.size) {
      for (const s of bad) this.stagePool.strikeWorker(jobId, s.endpoint);
      const kept = out.filter((s) => !bad.has(s));
      return kept.length ? kept : undefined;
    }
    return out.length ? out : undefined;
  }

  async *execute(req: ExecRequest): AsyncIterable<StreamChunk> {
    // B4 consent gate — ANTES de suscribir listeners ni reservar workers:
    // una instance pooled (sus activaciones intermedias viajan por forges
    // ajenos) jamás sirve un request sin opt-in explícito. El throw es
    // pre-token → el FailoverExec prueba el próximo candidato.
    if (this.isPooled?.() && req.allowPooled !== true) {
      throw new Error(`forge ${this.forgeId}: capacidad pooled sin consent del cliente`);
    }
    const jobId = req.jobId;
    const queue: (StreamChunk | { err: Error })[] = [];
    let wake: (() => void) | null = null;
    const wakeUp = () => {
      const w = wake;
      wake = null;
      w?.();
    };
    let failed: Error | null = null;
    const fail = (e: Error) => {
      failed = e;
      queue.push({ err: e });
      wakeUp();
    };
    let ackResolve!: () => void;
    let ackReject!: (e: Error) => void;
    const ack = new Promise<void>((res, rej) => {
      ackResolve = res;
      ackReject = rej;
    });
    // S42/I1 (ADR-0006): el proof debe atarse a LO SERVIDO — recomputamos
    // sha256 sobre los chunks en orden y lo comparamos con el resultHash
    // declarado. Un forge que firma el hash de otro output no cobra.
    const served = createHash("sha256");
    let servedChunks = 0; // tokens medidos gateway-side — el forge no declara su pago
    let completed = false;
    const un = this.channel.onMessage((m) => {
      if (completed || !("jobId" in m) || m.jobId !== jobId) return;
      switch (m.type) {
        case "job.ack":
          ackResolve();
          break;
        case "job.chunk":
          // think fuera del hash (contrato proofhash): el output verificable
          // es el contenido visible. Los chunks sí cuentan para billing —
          // el razonamiento es trabajo real medido gateway-side.
          if (m.kind !== "think") served.update(m.token, "utf8");
          servedChunks++;
          queue.push({ token: m.token, done: false, ...(m.kind ? { kind: m.kind } : {}) });
          wakeUp();
          break;
        case "job.done": {
          completed = true;
          // Async: la verificación de stageSigs puede ser async (verify EVM).
          // `completed` ya quedó — un job.fail posterior se ignora.
          void this.finishDone(m, req, served, servedChunks, queue, wakeUp, usedPooled).catch(fail);
          break;
        }
        case "job.fail":
          completed = true; // el job terminó — no mandar job.cancel al salir
          // poolBlame: el daemon reporta que fallaron los PEERS (pooled spawn)
          // — el finally penaliza a los workers del préstamo, no al forge.
          if (m.poolBlame) blamedPeers = true;
          fail(new Error(m.error));
          break;
        default:
          break;
      }
    });
    const unClose = this.channel.onClose(() => {
      const e = new Error(`forge ${this.forgeId}: desconectado`);
      ackReject(e);
      if (!queue.some((c) => "err" in c || c.done)) fail(e);
    });
    // Abort del cliente (req.signal): corta el stream local — el finally
    // manda job.cancel al daemon para liberar la GPU del forge.
    const onAbort = () => fail(new Error("abortado por el cliente"));
    req.signal?.addEventListener("abort", onAbort, { once: true });
    // S46 pool-forge: si la instance pidió pool (pool.needs en su heartbeat),
    // reservamos workers acá — atómico con el dispatch, pre-token. El acquire
    // probea TCP a los endpoints; sin elegibles → throw → failover honesto.
    // acquireP se guarda aparte: si el consumidor aborta MID-ACQUIRE el
    // finally corre ANTES de que el await se resuelva — el loan igual queda
    // creado cuando el acquire termine, y el release debe viajar CON esa
    // promesa o los workers quedan busy para siempre (leak real).
    const acquireP = this.pool ? this.pool.acquire(this.forgeId, this.forgePubkey, jobId) : null;
    // S47 stage-federation: si la instance declaró pipeline, adquiere la
    // cadena de stage-workers (misma disciplina: reserva pre-probe, null =
    // cobertura insuficiente → failover honesto).
    const stageP = this.stagePool ? this.stagePool.acquire(this.forgeId, this.forgePubkey, jobId) : null;
    let blamedPeers = false;
    let usedPooled = false;
    try {
      const peers = acquireP ? await acquireP : [];
      if (peers === null) throw new Error(`forge ${this.forgeId}: pool sin workers elegibles`);
      const stages = stageP ? await stageP : [];
      if (stages === null) throw new Error(`forge ${this.forgeId}: stage-pool sin cobertura de bloques`);
      usedPooled = peers.length > 0 || stages.length > 0;
      // El consumidor murió DURANTE el acquire (abort/close mid-probe): no
      // despachar el assign — el daemon spawnearía un llama-server del peso
      // del modelo para servirle tokens a nadie. El loan ya creado lo
      // libera el finally vía acquireP.
      if (failed) throw failed;
      // Cold start pooled: el daemon spawnea llama-server --rpc al recibir el
      // assign — el primer token incluye el boot completo del cluster.
      const firstTokenMs =
        peers.length > 0 || stages.length > 0 ? Math.max(this.firstTokenTimeoutMs, this.pooledFirstTokenMs) : this.firstTokenTimeoutMs;
      this.channel.send({
        type: "job.assign",
        jobId,
        instanceId: this.forgeId,
        model: req.model,
        prompt: req.prompt,
        ...(req.messages ? { messages: req.messages } : {}),
        ...(req.options ? { options: req.options } : {}),
        ...(req.tools ? { tools: req.tools } : {}),
        ...(req.resume ? { resume: req.resume } : {}),
        ...(peers.length ? { rpcPeers: peers } : {}),
        ...(stages.length ? { stages } : {}),
      });
      await withTimeout(ack, this.ackTimeoutMs, `forge ${this.forgeId}: assign sin ack`);
      let first = true;
      for (;;) {
        while (queue.length === 0) {
          const p = new Promise<void>((r) => {
            wake = r;
          });
          // Timeout solo hasta el primer token: post-token el stream fluye y
          // un stall lo cubren job.fail / close del canal.
          if (first) await withTimeout(p, firstTokenMs, `forge ${this.forgeId}: primer token timeout`);
          else await p;
        }
        const c = queue.shift()!;
        if ("err" in c) throw c.err;
        if (first) {
          first = false;
          req.onForge?.(this.forgeId); // sirvió de verdad: hay token
        }
        yield c;
        if (c.done) return;
      }
    } finally {
      // Consumidor abortó con job vivo (cliente se fue mid-stream): avisamos
      // al daemon para que corte el cómputo — antes el forge terminaba el job
      // en vacío quemando GPU que nadie iba a pagar.
      if (!completed && this.channel.isAlive()) {
        try {
          this.channel.send({ type: "job.cancel", jobId });
        } catch {
          /* canal muriendo — el daemon lo nota por su lado */
        }
      }
      // Workers vuelven al pool — mismo contrato que job.cancel con la GPU.
      // El release viaja sobre acquireP: cubre el happy path (loan ya creado)
      // Y el abort mid-acquire (el loan aparece cuando la promesa termine —
      // penalize+release corren ahí). release/penalize son idempotentes.
      if (acquireP) {
        void acquireP
          .then(() => {
            if (blamedPeers) this.pool?.penalize(jobId);
            this.pool?.release(jobId);
          })
          .catch(() => {});
      }
      if (stageP) {
        void stageP
          .then(() => {
            if (blamedPeers) this.stagePool?.penalize(jobId);
            this.stagePool?.release(jobId);
          })
          .catch(() => {});
      }
      un();
      unClose();
      req.signal?.removeEventListener("abort", onAbort);
    }
  }
}

export class RemoteImageExec implements ImageExec {
  readonly forgeId: string;
  readonly model: string;
  private readonly channel: ForgeChannel;
  private readonly timeoutMs: number;

  constructor(opts: { channel: ForgeChannel; instanceId: string; model: string; timeoutMs?: number }) {
    this.channel = opts.channel;
    this.forgeId = opts.instanceId;
    this.model = opts.model;
    this.timeoutMs = opts.timeoutMs ?? 300_000; // difusión COLD paga load real
  }

  probe(): Promise<boolean> {
    return Promise.resolve(this.channel.isAlive());
  }

  generateImage(req: ImageRequest): Promise<ImageResult> {
    const jobId = req.jobId;
    return new Promise<ImageResult>((res, rej) => {
      const un = this.channel.onMessage((m) => {
        if (!("jobId" in m) || m.jobId !== jobId) return;
        if (m.type === "image.result") {
          done();
          res({ forgeId: this.forgeId, b64: m.b64, ms: m.ms });
        } else if (m.type === "job.fail") {
          done();
          rej(new Error(m.error));
        }
      });
      const unClose = this.channel.onClose(() => {
        done();
        rej(new Error(`forge ${this.forgeId}: desconectado`));
      });
      const timer = setTimeout(() => {
        done();
        rej(new Error(`forge ${this.forgeId}: imagegen timeout`));
      }, this.timeoutMs);
      const done = () => {
        clearTimeout(timer);
        un();
        unClose();
        req.signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        done();
        // El daemon aborta su engine — no quemar GPU para un cliente que se fue.
        this.channel.send({ type: "job.cancel", jobId });
        rej(new Error(`forge ${this.forgeId}: job abortado por el consumidor`));
      };
      // Abort previo al assign: el job ni siquiera arranca (nada que cancelar).
      if (req.signal?.aborted) {
        rej(new Error(`forge ${this.forgeId}: job abortado por el consumidor`));
        return;
      }
      req.signal?.addEventListener("abort", onAbort, { once: true });
      this.channel.send({
        type: "image.assign",
        jobId,
        instanceId: this.forgeId,
        model: req.model,
        prompt: req.prompt,
        ...(req.size ? { size: req.size } : {}),
      });
    });
  }
}
