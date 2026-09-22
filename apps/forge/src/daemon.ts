// S33 — ForgeDaemon: el forge real, lado operador (ADR-0005).
// Recibe un DaemonChannel YA autenticado (ws.ts hace challenge+firma) y
// corre el protocolo: heartbeats con capacidad MEDIDA local (TrackedExec
// inFlight, resident() del adapter, tok/s de stats reales) y dispatch de
// jobs a los execs locales — los mismos adapters que hoy viven embedded.
//
// El secreto Stellar jamás sale de este proceso: solo se usa para firmar
// (nonce de auth + proof L0 por job). sign() llega inyectado.
import { createHash } from "node:crypto";
import type { DaemonChannel, GatewayMsg, InstanceReport } from "@weaver/forge-net";
import type { ForgeExec, ImageExec } from "@weaver/forge-exec";
import { ollamaVramUsedGb, osIdleMs } from "./budgets.ts";

export type DaemonInstance = {
  instanceId: string;
  model: string;
  capability: "text" | "image";
  exec: ForgeExec | ImageExec; // TrackedExec/TrackedImageExec → inFlight medido
  maxConcurrent: number; // cap propio del operador → saturated honesto
  loadTimeMs: number; // carga COLD estimada (declarada, se refina con historia)
  vramGb?: number; // footprint estimado del modelo (budgets; /api/tags size)
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

const TOK_WINDOW = 50; // últimas N ejecuciones para tok/s medido

export class ForgeDaemon {
  private readonly channel: DaemonChannel;
  private readonly instances: Map<string, DaemonInstance>;
  private readonly sign: (hash: Buffer) => Buffer;
  private readonly heartbeatMs: number;
  private readonly budgets?: DaemonBudgets;
  private readonly claim?: Claimer;
  private readonly probes: BudgetProbes;
  private readonly tok = new Map<string, { tok: number; ms: number }[]>();
  private hbTimer: ReturnType<typeof setInterval> | null = null;
  private unMsg: (() => void) | null = null;

  constructor(deps: {
    channel: DaemonChannel;
    instances: DaemonInstance[];
    sign: (hash: Buffer) => Buffer;
    heartbeatMs?: number;
    budgets?: DaemonBudgets;
    claim?: Claimer;
    probes?: Partial<BudgetProbes>;
  }) {
    this.channel = deps.channel;
    this.instances = new Map(deps.instances.map((i) => [i.instanceId, i]));
    this.sign = deps.sign;
    this.heartbeatMs = deps.heartbeatMs ?? 5_000;
    this.budgets = deps.budgets;
    this.claim = deps.claim;
    this.probes = {
      idleMs: deps.probes?.idleMs ?? osIdleMs,
      vramUsedGb: deps.probes?.vramUsedGb ?? (() => ollamaVramUsedGb()),
    };
  }

  start(): void {
    this.unMsg = this.channel.onMessage((m) => void this.onMsg(m));
    void this.beat();
    this.hbTimer = setInterval(() => void this.beat(), this.heartbeatMs);
    this.hbTimer.unref?.();
  }

  stop(): void {
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.hbTimer = null;
    this.unMsg?.();
    this.unMsg = null;
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
      // hot = residencia real del modelo en el engine (texto). Imagen no
      // tiene resident() → probe() del runner (vivo = servible).
      const hot =
        i.capability === "image"
          ? ((await i.exec.probe?.().catch(() => false)) ?? true)
          : ((await (i.exec as ForgeExec).resident?.().catch(() => false)) ?? true);
      const n = (i.exec as unknown as { inFlight?: number }).inFlight ?? 0;
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
        saturated: busyUser || overVram || n >= i.maxConcurrent,
        ...(ms > 0 ? { tokPerSec: (tok / ms) * 1000 } : {}),
        loadTimeMs: i.loadTimeMs,
      });
    }
    this.channel.send({ type: "heartbeat", instances });
  }

  private async onMsg(m: GatewayMsg): Promise<void> {
    switch (m.type) {
      case "ping":
        this.channel.send({ type: "pong", t: m.t });
        break;
      case "job.assign":
        await this.runJob(m);
        break;
      case "image.assign":
        await this.runImage(m);
        break;
      case "job.funded":
        this.onFunded(m);
        break;
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
    void this.claim(m.chainJobId, hash, this.sign(hash))
      .then((tx) => console.log(`self-claim job ${m.chainJobId} ✓ tx ${tx}`))
      .catch((e) => {
        if (/BadState/i.test(String(e))) return; // ya released por el sweep
        console.warn(`self-claim job ${m.chainJobId} falló:`, e);
      });
  }

  private fail(jobId: string, error: string, midStream: boolean): void {
    this.channel.send({ type: "job.fail", jobId, error, midStream });
  }

  private async runJob(m: Extract<GatewayMsg, { type: "job.assign" }>): Promise<void> {
    const i = this.instances.get(m.instanceId);
    if (!i || i.capability !== "text") {
      return this.fail(m.jobId, `instance ${m.instanceId} desconocida o no-text`, false);
    }
    this.channel.send({ type: "job.ack", jobId: m.jobId });
    const hasher = createHash("sha256");
    let midStream = false;
    try {
      for await (const c of (i.exec as ForgeExec).execute({
        jobId: m.jobId,
        model: m.model,
        prompt: m.prompt,
        ...(m.messages ? { messages: m.messages } : {}),
        ...(m.options ? { options: m.options } : {}),
        ...(m.tools ? { tools: m.tools } : {}),
      })) {
        if (!c.done) {
          midStream = true;
          hasher.update(c.token, "utf8");
          this.channel.send({ type: "job.chunk", jobId: m.jobId, token: c.token, ...(c.kind ? { kind: c.kind } : {}) });
        } else {
          if (c.stats?.genTokens && c.stats.decodeMs) {
            const xs = this.tok.get(i.instanceId) ?? [];
            xs.push({ tok: c.stats.genTokens, ms: c.stats.decodeMs });
            if (xs.length > TOK_WINDOW) xs.shift();
            this.tok.set(i.instanceId, xs);
          }
          const hash = hasher.digest();
          this.channel.send({
            type: "job.done",
            jobId: m.jobId,
            resultHash: hash.toString("hex"),
            signature: this.sign(hash).toString("hex"),
            ...(c.stats ? { stats: c.stats } : {}),
            ...(c.toolCalls ? { toolCalls: c.toolCalls } : {}),
          });
        }
      }
    } catch (e) {
      this.fail(m.jobId, e instanceof Error ? e.message : String(e), midStream);
    }
  }

  private async runImage(m: Extract<GatewayMsg, { type: "image.assign" }>): Promise<void> {
    const i = this.instances.get(m.instanceId);
    if (!i || i.capability !== "image") {
      return this.fail(m.jobId, `instance ${m.instanceId} desconocida o no-image`, false);
    }
    try {
      const r = await (i.exec as ImageExec).generateImage({
        jobId: m.jobId,
        model: m.model,
        prompt: m.prompt,
        ...(m.size ? { size: m.size } : {}),
      });
      this.channel.send({ type: "image.result", jobId: m.jobId, b64: r.b64, ms: r.ms });
    } catch (e) {
      this.fail(m.jobId, e instanceof Error ? e.message : String(e), false);
    }
  }
}
