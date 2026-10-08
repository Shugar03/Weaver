// S33 — ForgeDaemon: el forge real, lado operador (ADR-0005).
// Recibe un DaemonChannel YA autenticado (ws.ts hace challenge+firma) y
// corre el protocolo: heartbeats con capacidad MEDIDA local (TrackedExec
// inFlight, resident() del adapter, tok/s de stats reales) y dispatch de
// jobs a los execs locales — los mismos adapters que hoy viven embedded.
//
// El secreto jamás sale de este proceso (Stellar ed25519 o EVM secp256k1
// según cfg.chain): solo se usa para firmar — nonce de auth + proof L0.
// sign() llega inyectado.
import { createHash } from "node:crypto";
import type { DaemonChannel, GatewayMsg, InstanceReport } from "@weaver/forge-net";
import type { ForgeExec, ImageExec } from "@weaver/forge-exec";
import { commitProof, promptHashOf } from "@weaver/forge-exec";
import { ollamaVramUsedGb, osIdleMs } from "./budgets.ts";

export type DaemonInstance = {
  instanceId: string;
  model: string;
  capability: "text" | "image" | "rpc-worker" | "stage-worker";
  exec?: ForgeExec | ImageExec; // ausente en rpc-worker — presta VRAM, no sirve jobs
  maxConcurrent: number; // cap propio del operador → saturated honesto
  loadTimeMs: number; // carga COLD estimada (declarada, se refina con historia)
  vramGb?: number; // footprint estimado del modelo (budgets; /api/tags size)
  // S46 pool-forge (spec 017):
  // rpc-worker: endpoint que el coordinator diala + handle del proceso
  // ggml-rpc-server (lo spawnea cli.ts — el daemon solo le reporta salud).
  rpc?: { endpoint: string; vramGb?: number };
  rpcProc?: { alive: boolean };
  // Self-probe del endpoint (TCP al propio bind): el proceso puede vivir
  // con el socket muerto — live para el gateway = proc vivo Y alcanzable.
  rpcProbe?: () => Promise<boolean>;
  // coordinator pooled: "sirvo este modelo si me parkean N workers" — el
  // gateway incluye rpcPeers en el assign y el daemon usa pooledFactory.
  // minVramGb viaja para que el pairing filtre workers chicos.
  pool?: { needs: number; minVramGb?: number };
  // GGUF local para el llama-server pooled (lo consume la factory de cli.ts).
  modelFile?: string;
  // S47 stage-federation (spec 018):
  // stage-worker: hospeda bloques [k,n) — nunca ve prompts, procesa hidden
  // states en un stage-server TCP (lo spawnea cli.ts; acá solo va la salud).
  stage?: { layers: [number, number]; endpoint: string; vramGb?: number; tps?: number };
  stageServer?: { alive: boolean; sessions?: number };
  stageProbe?: () => Promise<boolean>;
  // coordinator federado: "sirvo este modelo si me armás la cadena" — el
  // daemon NO tiene el modelo completo local; sin stages en el assign no
  // puede servir (fail honesto, no finge un exec residente).
  pipeline?: { blocks: number };
};

// S39: probes de OS/engine inyectables — los tests meten fakes, prod usa los
// reales de budgets.ts. null = no medible → comportamiento conservador.
export type BudgetProbes = {
  idleMs: () => Promise<number | null>;
  vramUsedGb: () => Promise<number | null>;
};

export type DaemonBudgets = {
  idleOnly?: boolean; // solo computar cuando la máquina está idle
  idleThresholdMs?: number; // default 60s sin input = idle
  maxVramGb?: number; // instances COLD solo se ofrecen si su carga entra
};

// S42 (I4): seam de self-claim — ante job.funded el daemon firma el
// resultHash de nuevo y reclama el release on-chain sin el operador.
// Ausente (sin --contract) → job.funded se loguea y nada más.
export type Claimer = (chainJobId: number, resultHash: Buffer, forgeSig: Buffer) => Promise<string>;

// Signer del proof L0: sync (ed25519 Stellar) o async (personal_sign EVM —
// viem devuelve Promise). El daemon espera ambos igual.
export type ProofSigner = (hash: Buffer) => Buffer | Promise<Buffer>;

// S46: coordinator pooled — ante job.assign con rpcPeers, la factory arma el
// exec contra el cluster (prod: spawnea llama-server --rpc peers warm-keyed
// por peer-set + OpenAICompatAdapter). Inyectable → tests con fakes.
// signal: el abort del job — un cancel mid-boot debe poder matar el spawn
// (un llama-server de 70B tarda minutos; sin signal quemaría GPU al muerto).
// dispose: daemon.stop() → matar los warm servers (VRAM liberada al apagar,
// no solo al exit del proceso).
export type PooledFactory = {
  (inst: DaemonInstance, peers: string[], signal?: AbortSignal): Promise<ForgeExec>;
  dispose?(): void;
};

// S47: coordinator federado — ante job.assign con stages, la factory arma el
// PipelineExec (embeddings+lmhead locales, stages remotos por relay TCP —
// spec 018 / Petals Algo 1). Inyectable → tests con fakes.
// requestStage: el exec pide un reemplazo mid-job (stage.need → stage.offer);
// el daemon lo cablea al canal gateway — ausente → sin heal (fail honesto).
export type StageRequester = (
  dead: string,
  blocks: [number, number],
) => Promise<{ endpoint?: string; blocks?: [number, number] }>;

export type PipelineFactory = {
  (
    inst: DaemonInstance,
    stages: { endpoint: string; blocks: [number, number] }[],
    signal?: AbortSignal,
    requestStage?: StageRequester,
  ): Promise<ForgeExec>;
  dispose?(): void;
};

// S46 hardening: allowlist operador-side de los peers que el daemon acepta
// dialar. El assign viene del gateway — si está comprometido/buggeado no
// queremos que un forge cualquiera abra conexiones RPC arbitrarias (el
// parser ggml-rpc del llama-server es C++ atacable). Ausente = acepta
// (default MVP; cli.ts la arma con --rpc-allow).
export type PeerAllowlist = (peers: string[]) => boolean;

const TOK_WINDOW = 50; // últimas N ejecuciones para tok/s medido

export class ForgeDaemon {
  private readonly channel: DaemonChannel;
  private readonly instances: Map<string, DaemonInstance>;
  private readonly sign: ProofSigner;
  private readonly heartbeatMs: number;
  private readonly budgets?: DaemonBudgets;
  private readonly claim?: Claimer;
  private readonly agentId?: number; // ERC-8004 (EVM) — viaja en el heartbeat
  private readonly probes: BudgetProbes;
  private readonly pooledFactory?: PooledFactory;
  private readonly pipelineFactory?: PipelineFactory;
  private readonly allowRpcPeers?: PeerAllowlist;
  private readonly allowStages?: PeerAllowlist;
  private readonly tok = new Map<string, { tok: number; ms: number }[]>();
  private readonly running = new Map<string, AbortController>(); // jobId → cancel
  // stage.need en vuelo: jobId → resolver del offer. Uno por job (el heal
  // del pipeline es secuencial); el timeout resuelve vacío = "sin reemplazo".
  private readonly stageNeeds = new Map<string, (o: { endpoint?: string; blocks?: [number, number] }) => void>();
  private hbTimer: ReturnType<typeof setInterval> | null = null;
  private unMsg: (() => void) | null = null;
  private unClose: (() => void) | null = null;

  constructor(deps: {
    channel: DaemonChannel;
    instances: DaemonInstance[];
    sign: ProofSigner;
    heartbeatMs?: number;
    budgets?: DaemonBudgets;
    claim?: Claimer;
    agentId?: number;
    probes?: Partial<BudgetProbes>;
    pooledFactory?: PooledFactory;
    pipelineFactory?: PipelineFactory;
    allowRpcPeers?: PeerAllowlist;
    allowStages?: PeerAllowlist;
  }) {
    this.channel = deps.channel;
    this.instances = new Map(deps.instances.map((i) => [i.instanceId, i]));
    this.sign = deps.sign;
    this.heartbeatMs = deps.heartbeatMs ?? 5_000;
    this.budgets = deps.budgets;
    this.claim = deps.claim;
    this.agentId = deps.agentId;
    this.probes = {
      idleMs: deps.probes?.idleMs ?? osIdleMs,
      vramUsedGb: deps.probes?.vramUsedGb ?? (() => ollamaVramUsedGb()),
    };
    this.pooledFactory = deps.pooledFactory;
    this.pipelineFactory = deps.pipelineFactory;
    this.allowRpcPeers = deps.allowRpcPeers;
    this.allowStages = deps.allowStages;
  }

  start(): void {
    this.unMsg = this.channel.onMessage((m) => void this.onMsg(m));
    // Canal muerto = el output ya no puede entregarse — abortar los jobs en
    // vuelo o el engine sigue quemando GPU para nadie (kill/chaos/drop).
    this.unClose = this.channel.onClose(() => {
      for (const ac of this.running.values()) ac.abort();
    });
    void this.beat();
    this.hbTimer = setInterval(() => void this.beat(), this.heartbeatMs);
    this.hbTimer.unref?.();
  }

  stop(): void {
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.hbTimer = null;
    this.unMsg?.();
    this.unMsg = null;
    // Abort manual: channel.close() dispara 'close' async y el onClose puede
    // ya estar desuscripto — el abort es idempotente.
    for (const ac of this.running.values()) ac.abort();
    // Los llama-server warm del pooledFactory mueren con el daemon — GBs de
    // VRAM liberados al parar, no solo al exit del proceso.
    this.pooledFactory?.dispose?.();
    this.pipelineFactory?.dispose?.();
    // stage.need pendientes: sin canal no llega el offer — resolver vacío
    // para que el pipeline falle honesto en vez de colgar su await.
    for (const r of this.stageNeeds.values()) r({});
    this.stageNeeds.clear();
    // Suelta el socket: connectLoop.onClose resuelve, cancel() no deja el
    // daemon colgado con una conexión zombie.
    this.channel.close?.();
    this.unClose?.();
    this.unClose = null;
  }

  private async beat(): Promise<void> {
    if (!this.channel.isAlive()) return;
    // S39: budgets del operador, evaluados por heartbeat (la máquina puede
    // oscilar idle↔activa entre beats — el reporte siempre es el AHORA).
    // idleOnly: usuario activo o idle no medible → todas saturated (existen
    // pero no toman jobs; honesto, distinto de muertas).
    let busyUser = false;
    if (this.budgets?.idleOnly) {
      const idle = await this.probes.idleMs();
      busyUser = idle === null || idle < (this.budgets.idleThresholdMs ?? 60_000);
    }
    // maxVramGb: instance COLD solo se ofrece si cargarla entra en budget.
    // HOT ya está en VRAM (su costo ya se pagó) — siempre se ofrece.
    const maxVram = this.budgets?.maxVramGb;
    const vramUsed = maxVram !== undefined ? await this.probes.vramUsedGb() : null;
    const instances: InstanceReport[] = [];
    for (const i of this.instances.values()) {
      // rpc-worker: no tiene exec — su salud ES el proceso ggml-rpc-server
      // Y que su endpoint realmente acepte conexiones (self-probe TCP: el
      // proceso puede vivir con el socket muerto/bindeado a otra iface).
      // Jamás recibe job.assign (el gateway no lo rutea); solo se parkea.
      if (i.capability === "rpc-worker") {
        const alive =
          i.rpcProc?.alive === true &&
          (i.rpcProbe ? await i.rpcProbe().catch(() => false) : true);
        instances.push({
          instanceId: i.instanceId,
          model: i.model,
          capability: "rpc-worker",
          hot: alive,
          inFlight: 0,
          saturated: !alive || busyUser,
          loadTimeMs: 0,
          ...(i.rpc ? { rpc: i.rpc } : {}),
        });
        continue;
      }
      // stage-worker: su salud ES el stage-server TCP (proc vivo + endpoint
      // alcanzable — mismo criterio que rpc-worker). Jamás recibe job.assign
      // con prompt; el gateway solo lo incluye en `stages` del coordinator.
      // inFlight = sessions activas (KV ocupado) — parkeable solo si hay lugar.
      if (i.capability === "stage-worker") {
        const alive =
          (i.stageServer?.alive === true) &&
          (i.stageProbe ? await i.stageProbe().catch(() => false) : true);
        const sessions = i.stageServer?.sessions ?? 0;
        instances.push({
          instanceId: i.instanceId,
          model: i.model,
          capability: "stage-worker",
          hot: alive,
          inFlight: sessions,
          saturated: !alive || busyUser || sessions >= i.maxConcurrent,
          loadTimeMs: 0,
          ...(i.stage ? { stage: i.stage } : {}),
        });
        continue;
      }
      // pipeline coordinator: NO tiene exec local (el modelo entero no cabe —
      // los stages llegan por assign del StagePool). Su "salud" no se mide
      // contra un engine residente: vive si el daemon vive, y su capacidad
      // real la decide el gateway al armar la cadena (null → failover).
      // hot = listo para coordinar; saturated solo si el operador está busy.
      if (i.pipeline) {
        instances.push({
          instanceId: i.instanceId,
          model: i.model,
          capability: i.capability,
          hot: true,
          inFlight: 0,
          saturated: busyUser,
          loadTimeMs: i.loadTimeMs,
          pipeline: i.pipeline,
        });
        continue;
      }
      // Liveness probe del engine local: si el proceso backend crasheó (OOM/ECONNREFUSED),
      // la instance no está viva ni hot, y se marca saturated para que el gateway no le asigne tráfico.
      const alive = i.exec ? ((await i.exec.probe?.().catch(() => false)) ?? true) : false;
      const hot =
        alive &&
        (i.capability === "image"
          ? true
          : ((await (i.exec as ForgeExec).resident?.().catch(() => false)) ?? true));
      const n = (i.exec as unknown as { inFlight?: number } | undefined)?.inFlight ?? 0;
      const xs = this.tok.get(i.instanceId) ?? [];
      const tok = xs.reduce((a, s) => a + s.tok, 0);
      const ms = xs.reduce((a, s) => a + s.ms, 0);
      const overVram =
        !hot && maxVram !== undefined && vramUsed !== null &&
        i.vramGb !== undefined && vramUsed + i.vramGb > maxVram;
      instances.push({
        instanceId: i.instanceId,
        model: i.model,
        capability: i.capability,
        hot,
        inFlight: n,
        saturated: !alive || busyUser || overVram || n >= i.maxConcurrent,
        ...(ms > 0 ? { tokPerSec: (tok / ms) * 1000 } : {}),
        loadTimeMs: i.loadTimeMs,
        ...(i.pool ? { pool: i.pool } : {}),
        ...(i.pipeline ? { pipeline: i.pipeline } : {}),
      });
    }
    this.channel.send({
      type: "heartbeat",
      instances,
      ...(this.agentId !== undefined ? { agentId: this.agentId } : {}),
    });
  }

  private async onMsg(m: GatewayMsg): Promise<void> {
    switch (m.type) {
      case "ping":
        this.channel.send({ type: "pong", t: m.t });
        break;
      case "job.assign":
        await this.runJob(m);
        break;
      case "job.cancel":
        // El consumidor se fue — corta el cómputo del job en vuelo.
        this.running.get(m.jobId)?.abort();
        break;
      case "image.assign":
        await this.runImage(m);
        break;
      case "job.funded":
        this.onFunded(m);
        break;
      case "stage.offer": {
        // Respuesta al stage.need de un pipeline en vuelo — offer vacío =
        // "no hay reemplazo" (el exec falla honesto, no espera de más).
        this.stageNeeds.get(m.jobId)?.({
          ...(m.endpoint ? { endpoint: m.endpoint } : {}),
          ...(m.blocks ? { blocks: m.blocks } : {}),
        });
        break;
      }
      default:
        break; // auth.ok/auth.fail los maneja ws.ts antes de crear el daemon
    }
  }

  // I4: el release del operador falló post-fund — el escrow quedó ligado a
  // nuestra pubkey. Self-claim: firmamos el resultHash otra vez (la firma no
  // expira) y llamamos release como caller=worker. BadState = ya cobró el
  // sweep del gateway → lo ignoramos.
  private onFunded(m: Extract<GatewayMsg, { type: "job.funded" }>): void {
    if (!this.claim) {
      console.log(`job.funded #${m.chainJobId} pendiente — sin --contract no puedo claimear (el gateway reintenta al boot)`);
      return;
    }
    const hash = Buffer.from(m.resultHash, "hex");
    void Promise.resolve(this.sign(hash))
      .then((sig) => this.claim!(m.chainJobId, hash, sig))
      .then((tx) => console.log(`self-claim job ${m.chainJobId} ✓ tx ${tx}`))
      .catch((e) => {
        if (/BadState/i.test(String(e))) return; // ya released por el sweep
        console.warn(`self-claim job ${m.chainJobId} falló:`, e);
      });
  }

  private fail(jobId: string, error: string, midStream: boolean, poolBlame = false): void {
    this.channel.send({ type: "job.fail", jobId, error, midStream, ...(poolBlame ? { poolBlame: true } : {}) });
  }

  // S47 heal: el pipeline pide un stage de reemplazo por endpoint muerto.
  // stage.need → gateway; el offer llega por onMsg. Timeout 10s = "sin
  // reemplazo" (el offer vacío y el timeout son indistinguibles — mismo
  // outcome: fail honesto).
  private requestStage(
    jobId: string,
    dead: string,
    blocks: [number, number],
  ): Promise<{ endpoint?: string; blocks?: [number, number] }> {
    return new Promise((res) => {
      const resolve = (o: { endpoint?: string; blocks?: [number, number] }) => {
        if (this.stageNeeds.get(jobId) === resolve) this.stageNeeds.delete(jobId);
        clearTimeout(t);
        res(o);
      };
      const t = setTimeout(() => resolve({}), 10_000);
      t.unref?.();
      this.stageNeeds.set(jobId, resolve);
      this.channel.send({ type: "stage.need", jobId, dead, blocks });
    });
  }

  private async runJob(m: Extract<GatewayMsg, { type: "job.assign" }>): Promise<void> {
    const i = this.instances.get(m.instanceId);
    if (!i || i.capability !== "text") {
      return this.fail(m.jobId, `instance ${m.instanceId} desconocida o no-text`, false);
    }
    // jobId duplicado pisaría el AbortController del job en vuelo — un
    // job.cancel llegaría solo al segundo y el primero quedaría incancelable.
    if (this.running.has(m.jobId)) {
      return this.fail(m.jobId, `jobId ${m.jobId} ya en vuelo`, false);
    }
    this.channel.send({ type: "job.ack", jobId: m.jobId });
    // S46: assign con rpcPeers → el exec no es el residente sino el pooled
    // (llama-server --rpc peers — la factory lo spawnea/reusa warm-keyed).
    // Defensa en profundidad: solo obedecemos peers si ESTA instancia los
    // pidió (pool declarado) — un gateway buggy/comprometido no puede hacer
    // que un forge normal abra conexiones RPC arbitrarias.
    const ac = new AbortController(); // job.cancel → aborta spawn/exec en vuelo
    let exec = i.exec as ForgeExec | undefined;
    if (m.rpcPeers?.length) {
      // Guards síncronos primero — sin awaits no hay interleave con
      // job.cancel; el AbortController se registra JUSTO antes del await.
      if (!i.pool) {
        return this.fail(m.jobId, `instance ${m.instanceId}: rpcPeers recibidos pero no soy pooled`, false);
      }
      if (this.allowRpcPeers && !this.allowRpcPeers(m.rpcPeers)) {
        return this.fail(m.jobId, `instance ${m.instanceId}: rpcPeers fuera de la allowlist del operador`, false);
      }
      if (!this.pooledFactory) {
        return this.fail(m.jobId, `instance ${m.instanceId}: rpcPeers recibidos pero sin pooledFactory`, false);
      }
      // Registrado ANTES del await: un cancel que llegue durante el boot del
      // llama-server aborta el spawn (antes se perdía y el job servía a un
      // consumidor muerto — GPU + workers quemados por nada).
      this.running.set(m.jobId, ac);
      try {
        exec = await this.pooledFactory(i, m.rpcPeers, ac.signal);
      } catch (e) {
        this.running.delete(m.jobId);
        // poolBlame solo si el spawn falló por los PEERS (endpoint muerto,
        // RPC roto). Si la causa fue un job.cancel mid-boot, culpar a los
        // workers los penalizaría injustamente — el gateway los evictaría
        // por algo que no hicieron.
        return this.fail(
          m.jobId,
          `pooled spawn falló: ${e instanceof Error ? e.message : String(e)}`,
          false,
          !ac.signal.aborted,
        );
      }
      if (ac.signal.aborted) {
        this.running.delete(m.jobId);
        return this.fail(m.jobId, "job cancelado durante el spawn pooled", false);
      }
    }
    // S47: assign con stages → el exec lo arma pipelineFactory (cadena de
    // stage-workers remotos, embeddings+lmhead locales). Misma defensa que
    // rpcPeers: solo instances que declararon `pipeline` obedecen stages —
    // un gateway buggy no puede hacer que un forge normal diale fronteras
    // arbitrarias. Recíproco: una instance pipeline SIN stages no puede
    // servir (no tiene el modelo entero local — fail honesto, no finge).
    if (m.stages?.length) {
      if (!i.pipeline) {
        return this.fail(m.jobId, `instance ${m.instanceId}: stages recibidos pero no soy pipeline`, false);
      }
      if (this.allowStages && !this.allowStages(m.stages.map((s) => s.endpoint))) {
        return this.fail(m.jobId, `instance ${m.instanceId}: stages fuera de la allowlist del operador`, false);
      }
      if (!this.pipelineFactory) {
        return this.fail(m.jobId, `instance ${m.instanceId}: stages recibidos pero sin pipelineFactory`, false);
      }
      this.running.set(m.jobId, ac);
      try {
        exec = await this.pipelineFactory(i, m.stages, ac.signal, (dead, blocks) =>
          this.requestStage(m.jobId, dead, blocks),
        );
      } catch (e) {
        this.running.delete(m.jobId);
        return this.fail(
          m.jobId,
          `pipeline spawn falló: ${e instanceof Error ? e.message : String(e)}`,
          false,
          !ac.signal.aborted, // poolBlame: stages culpables, no el coordinator
        );
      }
      if (ac.signal.aborted) {
        this.running.delete(m.jobId);
        return this.fail(m.jobId, "job cancelado durante el spawn del pipeline", false);
      }
    } else if (i.pipeline) {
      return this.fail(m.jobId, `instance ${m.instanceId}: pipeline sin stages — no puedo servir solo`, false);
    }
    if (!exec) return this.fail(m.jobId, `instance ${m.instanceId}: sin exec`, false);
    // Commitment input+output (proofhash.ts): el hash del prompt es sobre lo
    // que ESTE assign trajo — el gateway lo recomputa y compara, así que el
    // forge no puede reclamar que le llegó otro input.
    const promptHash = promptHashOf({
      model: m.model,
      prompt: m.prompt,
      ...(m.messages ? { messages: m.messages } : {}),
      ...(m.resume ? { resume: m.resume.prefix } : {}),
    });
    const hasher = createHash("sha256");
    let midStream = false;
    this.running.set(m.jobId, ac);
    try {
      for await (const c of exec.execute({
        jobId: m.jobId,
        model: m.model,
        prompt: m.prompt,
        signal: ac.signal,
        ...(m.messages ? { messages: m.messages } : {}),
        ...(m.options ? { options: m.options } : {}),
        ...(m.tools ? { tools: m.tools } : {}),
        ...(m.resume ? { resume: m.resume } : {}),
      })) {
        if (!c.done) {
          midStream = true;
          // think fuera del hash (mismo contrato que ProvenForgeExec): el
          // receipt ata el contenido visible, no el razonamiento efímero.
          if (c.kind !== "think") hasher.update(c.token, "utf8");
          this.channel.send({ type: "job.chunk", jobId: m.jobId, token: c.token, ...(c.kind ? { kind: c.kind } : {}) });
        } else {
          if (c.stats?.genTokens && c.stats.decodeMs) {
            const xs = this.tok.get(i.instanceId) ?? [];
            xs.push({ tok: c.stats.genTokens, ms: c.stats.decodeMs });
            if (xs.length > TOK_WINDOW) xs.shift();
            this.tok.set(i.instanceId, xs);
          }
          const outputHash = hasher.digest();
          const hash = commitProof(promptHash, outputHash);
          this.channel.send({
            type: "job.done",
            jobId: m.jobId,
            resultHash: hash.toString("hex"),
            promptHash: promptHash.toString("hex"),
            outputHash: outputHash.toString("hex"),
            signature: (await this.sign(hash)).toString("hex"),
            ...(c.stats ? { stats: c.stats } : {}),
            ...(c.toolCalls ? { toolCalls: c.toolCalls } : {}),
          });
        }
      }
    } catch (e) {
      this.fail(m.jobId, e instanceof Error ? e.message : String(e), midStream);
    } finally {
      this.running.delete(m.jobId);
    }
  }

  private async runImage(m: Extract<GatewayMsg, { type: "image.assign" }>): Promise<void> {
    const i = this.instances.get(m.instanceId);
    if (!i || i.capability !== "image" || !i.exec) {
      return this.fail(m.jobId, `instance ${m.instanceId} desconocida o no-image`, false);
    }
    // Mismo contrato que runJob: jobId único (un cancel no puede pisar a otro)
    // y AbortController — sin él la difusión seguía quemando GPU tras
    // job.cancel o canal muerto.
    if (this.running.has(m.jobId)) {
      return this.fail(m.jobId, `jobId ${m.jobId} ya en vuelo`, false);
    }
    const ac = new AbortController();
    this.running.set(m.jobId, ac);
    try {
      const r = await (i.exec as ImageExec).generateImage({
        jobId: m.jobId,
        model: m.model,
        prompt: m.prompt,
        ...(m.size ? { size: m.size } : {}),
        signal: ac.signal,
      });
      this.channel.send({ type: "image.result", jobId: m.jobId, b64: r.b64, ms: r.ms });
    } catch (e) {
      this.fail(m.jobId, e instanceof Error ? e.message : String(e), false);
    } finally {
      this.running.delete(m.jobId);
    }
  }
}
