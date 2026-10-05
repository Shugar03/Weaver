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
  StreamChunk,
} from "@weaver/forge-exec";
import type { ForgeMsg, GatewayMsg } from "./protocol.ts";

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
  private readonly isResident?: () => boolean;

  constructor(opts: {
    channel: ForgeChannel;
    instanceId: string;
    model: string;
    ackTimeoutMs?: number;
    firstTokenTimeoutMs?: number;
    resident?: () => boolean;
  }) {
    this.channel = opts.channel;
    this.forgeId = opts.instanceId;
    this.model = opts.model;
    this.ackTimeoutMs = opts.ackTimeoutMs ?? 3_000;
    this.firstTokenTimeoutMs = opts.firstTokenTimeoutMs ?? 60_000;
    this.isResident = opts.resident;
  }

  probe(): Promise<boolean> {
    return Promise.resolve(this.channel.isAlive());
  }

  resident(): Promise<boolean> {
    return Promise.resolve(this.isResident?.() ?? true);
  }

  async *execute(req: ExecRequest): AsyncIterable<StreamChunk> {
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
          const hasContent = servedChunks > 0 || Boolean(m.toolCalls && m.toolCalls.length > 0);
          if (!hasContent) {
            fail(new Error(`forge ${this.forgeId}: output vacío — cero chunks servidos no generan proof`));
            break;
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
            fail(new Error(`forge ${this.forgeId}: proof hash mismatch — el recibo no ata al input/output servido`));
            break;
          }
          // La firma también se sanea acá: un hex malformado produce un
          // buffer de longitud rara que el contrato rechaza on-chain —
          // mejor fallar antes que pagar el gas de un release inválido.
          // Válidas: 64B ed25519 (stellar) o 65B secp256k1 (evm).
          const sigBytes = Buffer.from(m.signature, "hex");
          if (sigBytes.length !== 64 && sigBytes.length !== 65) {
            fail(new Error(`forge ${this.forgeId}: firma malformada (${sigBytes.length}B)`));
            break;
          }
          req.onProof?.({
            forgeId: this.forgeId,
            resultHash: declared,
            signature: sigBytes,
            ...(m.promptHash ? { promptHash: Buffer.from(m.promptHash, "hex"), outputHash: servedOut } : {}),
          });
          queue.push({
            token: "",
            done: true,
            // genTokens MEDIDO: los chunks que relayeamos (atados al hash
            // verificado), no el conteo que el forge declara — su stats
            // declarativo puede inflar el pago; el nuestro no.
            stats: { ...(m.stats ?? {}), genTokens: servedChunks },
            ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}),
          });
          wakeUp();
          break;
        }
        case "job.fail":
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
    try {
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
          if (first) await withTimeout(p, this.firstTokenTimeoutMs, `forge ${this.forgeId}: primer token timeout`);
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
      un();
      unClose();
      // Job cancelado por el consumidor (break): queda unsubscripted — el
      // daemon termina el job en vacío. Sin job.cancel en v1 (declarado).
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
      };
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
