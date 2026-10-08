// S47 — PipelineExec (spec 018, Petals Algoritmo 1-3 lado coordinador).
// El coordinator es el "cliente" del paper: embeddings + lm_head + sampling
// LOCALES (es la única pieza además del usuario que ve plaintext); los
// stage-workers remotos procesan bloques contiguos y devuelven hidden states.
//
// Fault tolerance = dual attention cache:
// - KV vive EN el stage (server-side por sessionId).
// - `sent[i]` guarda TODAS las activaciones enviadas al stage i.
// - Stage muere mid-job → ban local → requestStage() al gateway (el pool es
//   la única autoridad de leases) → open nuevo → REPLAY de la historia
//   cacheada → el job continúa donde quedó, sin reenviar el prompt.
import { createHash } from "node:crypto";
import type { ExecRequest, ForgeExec, StageSig, StreamChunk } from "@weaver/forge-exec";
import { CKPT_INTERVAL, stageChainInit, stageChainStep, stageCkpt, stageHalfInit, stageHalfStep, stageSigPreimage, stageSigPreimageV2, stageTokenOk } from "@weaver/forge-net";
import type { StageDial, StageTransport } from "./stagetransport.ts";

// Frontera de activación entre coordinator y stage.
export type Hidden = { shape: [number, number]; payload: string }; // payload b64

// La mitad local del modelo (inyectable): embed del prompt y logits+sample+embed
// del siguiente token. Async — en prod el front es un edge-runner local
// (tools/stage_runner.py --role edge: embed_tokens + norm + lm_head + tokenizer
// del checkpoint real); stage-sim: modelo juguete.
export type PipelineFront = {
  embed(jobId: string, prompt: string): Promise<Hidden>;
  next(hidden: Hidden): Promise<{ token: string; done: false; embed: Hidden } | { done: true }>;
};

// Edge-runner real por HTTP (el "cliente" de Petals — la única pieza que ve
// plaintext: tokeniza, embed, samplea greedy. Stateless: el estado autoregresivo
// vive en los KV server-side de cada stage, el front solo re-embeds el token).
export function httpFront(url: string): PipelineFront {
  const post = async (path: string, body: object) => {
    const r = await fetch(`${url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`edge ${path}: HTTP ${r.status}`);
    return r.json() as Promise<Record<string, unknown>>;
  };
  return {
    embed: async (_jobId, prompt) => {
      const r = await post("/embed", { prompt });
      return { shape: r.shape as [number, number], payload: r.payload as string };
    },
    next: async (hidden) => {
      const r = await post("/next", { shape: hidden.shape, payload: hidden.payload });
      if (r.done) return { done: true };
      return { token: r.token as string, done: false, embed: { shape: (r.embed as { shape: [number, number] }).shape, payload: (r.embed as { payload: string }).payload } };
    },
  };
}

// stage.need → stage.offer: el coordinator pide reemplazo al gateway por
// endpoint muerto + tramo a cubrir. null en la respuesta = no hay — fail.
// token = capability B1 del reemplazo (el pool la minteó via el daemon del
// worker nuevo — sin ella el stage autorizado rechaza el open).
export type StageRequester = (
  dead: string,
  blocks: [number, number],
  // "audit" (B5): borrow efímero — el "dead" está vivo; el pool no lo
  // strikea ni lo saca del loan.chain (su sig sigue atribuible al job).
  purpose?: "heal" | "audit",
) => Promise<{ endpoint?: string; blocks?: [number, number]; token?: string }>;

type ChainEntry = {
  endpoint: string;
  blocks: [number, number];
  token?: string;
  transport: StageTransport;
  sessionId: string;
  // Chain de activaciones de ESTA sesión (stageChainInit/Step): el stage lo
  // computa sobre su lado y firma al close; nosotros sobre el tráfico que
  // vimos — mismatch = el stage firmó otra historia (el gateway lo nota).
  chain: string;
  // B5: half-chains coordinator-side — en relay los computamos sobre los
  // tensores que atraviesan; en direct los lleva el stage y sus ckpts los
  // recibimos por stage.report. Mismo seed jobId → comparable entre sesiones.
  inChain: string;
  outChain: string;
  // B5: weightsHash declarado por el stage en su open-ack — commitment a
  // qué pesos cargó; el auditor lo contrasta con el suyo (diagnóstico
  // "pesos distintos" separado de "cómputo diverge").
  weights?: string;
};

const STEP_TIMEOUT_MS = 30_000;

const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((_r, rej) => setTimeout(() => rej(new Error(`${what}: timeout ${ms}ms`)), ms)),
  ]);

export class PipelineExec implements ForgeExec {
  readonly forgeId: string;
  readonly model: string;
  private readonly stages: { endpoint: string; blocks: [number, number]; token?: string }[];
  private readonly dial: StageDial;
  private readonly front: PipelineFront;
  private readonly requestStage?: StageRequester;
  private readonly stepTimeoutMs: number;
  private readonly maxTokens: number;
  private readonly coordPubkey?: string;
  private readonly mode: "relay" | "direct";
  private readonly auditRate: number;

  constructor(deps: {
    forgeId: string;
    model: string;
    stages: { endpoint: string; blocks: [number, number]; token?: string }[];
    dial: StageDial;
    front: PipelineFront;
    requestStage?: StageRequester;
    stepTimeoutMs?: number;
    maxTokens?: number;
    // B1 WAN auth: pubkey del coordinator — va en stage.open para que el
    // token minteado (HMAC secret, jobId|coordPubkey) ate a ESTA identidad.
    coordPubkey?: string;
    // B2: "direct" = activaciones fluyen stage→stage (N+1 hops por token en
    // vez de 2N — el relay solo inyecta en s1 y espera el out de sN). Los
    // stages deben poder dialarse entre sí; relay queda como fallback para
    // endpoints NAT'd o substrate sin soporte fwd.
    mode?: "relay" | "direct";
    // B5 audit-by-replay (TOPLOC): probabilidad [0,1] de que tras completar
    // la generación se audite un ckpt — un spare del tramo reabsorbe los
    // ins hasta ese seq y su ckpt recomputado debe igualar el reportado.
    // Divergencia = cómputo deshonesto → el job falla post-tokens (honesto:
    // el output salió pero la evidencia dice que no es confiable).
    auditRate?: number;
  }) {
    this.forgeId = deps.forgeId;
    this.model = deps.model;
    this.stages = deps.stages;
    this.dial = deps.dial;
    this.front = deps.front;
    this.requestStage = deps.requestStage;
    this.stepTimeoutMs = deps.stepTimeoutMs ?? STEP_TIMEOUT_MS;
    this.maxTokens = deps.maxTokens ?? 512;
    this.coordPubkey = deps.coordPubkey;
    this.mode = deps.mode ?? "relay";
    this.auditRate = deps.auditRate ?? 0;
  }

  async *execute(req: ExecRequest): AsyncIterable<StreamChunk> {
    if (this.mode === "direct") {
      yield* this.executeDirect(req);
      return;
    }
    yield* this.executeRelay(req);
  }

  private async *executeRelay(req: ExecRequest): AsyncIterable<StreamChunk> {
    const jobId = req.jobId;
    const chain: ChainEntry[] = this.stages.map((s, i) => ({
      endpoint: s.endpoint,
      blocks: s.blocks,
      token: s.token,
      transport: this.dial(s.endpoint),
      sessionId: `${jobId}:s${i}`,
      chain: "",
      inChain: stageHalfInit(jobId),
      outChain: stageHalfInit(jobId),
    }));
    // B5: ckpts coordinator-side — en relay derivamos el commitment de las
    // half-chains locales cada CKPT_INTERVAL (el auditor las recomputa).
    const ckpts = new Map<string, { seq: number; hash: string; weights?: string }>();
    // sent[i] = historial completo de inputs enviados al stage i — el replay
    // buffer del dual-cache (Petals Algo 1: cache[server].append(inputs)).
    const sent: Hidden[][] = chain.map(() => []);
    const seq = chain.map(() => 0);
    const opened = new Set<string>(); // sessionIds con open confirmado
    const closed = new Set<string>();
    // stage.close espera el close-ack: {sig} = el stage firma su cadena.
    // `collect` no-null = happy path (firma → stageSigs); null = limpieza
    // tras fallo — se cierra igual pero la firma no se atribuye a nada.
    const closeSession = async (st: ChainEntry, collect: StageSig[] | null): Promise<void> => {
      if (!opened.has(st.sessionId) || closed.has(st.sessionId)) return;
      closed.add(st.sessionId);
      const ack = await st.transport.close(st.sessionId);
      if (ack.sig && collect) {
        collect.push({
          endpoint: st.endpoint,
          blocks: st.blocks,
          sessionId: st.sessionId,
          chain: st.chain,
          sig: ack.sig,
          ...(ack.inChain ? { inChain: ack.inChain } : {}),
          ...(ack.outChain ? { outChain: ack.outChain } : {}),
        });
      }
    };
    try {
      for (const st of chain) {
        const ack = await withTimeout(
          st.transport.open({
            jobId,
            sessionId: st.sessionId,
            model: req.model,
            blocks: st.blocks,
            kvLenHint: 1024,
            ...(st.token ? { token: st.token } : {}),
            ...(this.coordPubkey ? { coordPubkey: this.coordPubkey } : {}),
          }),
          this.stepTimeoutMs,
          `stage ${st.endpoint} open`,
        );
        st.weights = ack.weights;
        st.chain = stageChainInit(st.sessionId, st.blocks);
        opened.add(st.sessionId);
      }
      let cur = await this.front.embed(jobId, req.prompt);
      let genTokens = 0;
      const t0 = Date.now();
      const limit = req.options?.maxTokens ?? this.maxTokens;
      while (genTokens < limit) {
        if (req.signal?.aborted) throw new Error("job cancelado");
        for (let i = 0; i < chain.length; i++) {
          cur = await this.step(chain, i, cur, sent, seq, jobId, req, opened, ckpts);
        }
        const r = await this.front.next(cur);
        if (r.done) break;
        genTokens++;
        yield { token: r.token, done: false };
        cur = r.embed;
      }
      // B5 audit-by-replay: post-generación, pre-close — un tramo auditado
      // que diverge mata el job con evidencia (los tokens ya salieron; la
      // confianza no).
      await this.auditByReplay(chain, ckpts, (i) => sent[i], jobId, req);
      // Close-acks ANTES del done: el stage firma su chain completo — las
      // stageSigs viajan en el done chunk (atribución por tramo, A4).
      const stageSigs: StageSig[] = [];
      for (const st of chain) await closeSession(st, stageSigs);
      yield {
        token: "",
        done: true,
        stats: { genTokens, decodeMs: Date.now() - t0, promptTokens: Math.ceil(req.prompt.length / 4) },
        ...(stageSigs.length ? { stageSigs } : {}),
      };
    } finally {
      for (const st of chain) {
        await closeSession(st, null);
        st.transport.dispose();
      }
    }
  }

  // Un paso por el stage i con heal completo (Petals Algo 3):
  // step → si muere: ban + requestStage + open nuevo + replay + retry.
  private async step(
    chain: ChainEntry[],
    i: number,
    input: Hidden,
    sent: Hidden[][],
    seq: number[],
    jobId: string,
    req: ExecRequest,
    opened: Set<string>,
    ckpts?: Map<string, { seq: number; hash: string; weights?: string }>,
  ): Promise<Hidden> {
    const st = chain[i];
    // doStep devuelve la activación Y actualiza el chain de la sesión — la
    // misma fórmula que el stage lleva server-side (stageChainStep).
    const doStep = async (t: StageTransport, st2: ChainEntry, payload: Hidden, n: number) => {
      const r = await withTimeout(
        t.step({ sessionId: st2.sessionId, seq: n, shape: payload.shape, dtype: "f16", payload: payload.payload }),
        this.stepTimeoutMs,
        `stage ${st2.endpoint} step`,
      );
      st2.chain = stageChainStep(st2.chain, n, payload.payload, r.payload);
      st2.inChain = stageHalfStep(st2.inChain, n, payload.payload);
      st2.outChain = stageHalfStep(st2.outChain, n, r.payload);
      // B5: ckpt derivado local — el auditor reabsorbe ins[0..n] y debe
      // producir este mismo commitment (comparable por seed compartido).
      if (ckpts && (n + 1) % CKPT_INTERVAL === 0) {
        ckpts.set(st2.sessionId, { seq: n, hash: stageCkpt(n, st2.inChain, st2.outChain), ...(st2.weights ? { weights: st2.weights } : {}) });
      }
      return r;
    };
    try {
      const r = await doStep(st.transport, st, input, seq[i]);
      sent[i].push(input);
      seq[i]++;
      return { shape: input.shape, payload: r.payload };
    } catch (e) {
      if (req.signal?.aborted || !this.requestStage) throw e;
      const err = e instanceof Error ? e : new Error(String(e));
      // Ban local: el transport muerto no se reintenta.
      st.transport.dispose();
      const offer = await this.requestStage(st.endpoint, st.blocks).catch(() => null);
      if (!offer?.endpoint || !offer.blocks) {
        throw new Error(`stage ${st.endpoint} murió sin reemplazo: ${err.message}`);
      }
      // Nueva sesión + REPLAY de las activaciones cacheadas — el stage nuevo
      // reconstruye su KV desde lo que el muerto ya había procesado (O(t)
      // una vez; el resto de la cadena no recomputa).
      const t = this.dial(offer.endpoint);
      const sessionId = `${st.sessionId}r${seq[i]}`;
      await withTimeout(
        t.open({
          jobId,
          sessionId,
          model: req.model,
          blocks: offer.blocks,
          ...(offer.token ? { token: offer.token } : {}),
          ...(this.coordPubkey ? { coordPubkey: this.coordPubkey } : {}),
        }),
        this.stepTimeoutMs,
        `stage ${offer.endpoint} open`,
      );
      // Swap en la cadena — chain nuevo por sesión (el replay lo repuebla
      // idéntico al que el stage computa server-side).
      const next: ChainEntry = {
        endpoint: offer.endpoint,
        blocks: offer.blocks,
        token: offer.token,
        transport: t,
        sessionId,
        chain: stageChainInit(sessionId, offer.blocks),
        inChain: stageHalfInit(jobId),
        outChain: stageHalfInit(jobId),
      };
      opened.add(sessionId);
      for (const [n, past] of sent[i].entries()) {
        await doStep(t, next, past, n).then(
          () => {},
          (re) => {
            throw new Error(`stage ${offer.endpoint} replay seq ${n} falló: ${re instanceof Error ? re.message : re}`);
          },
        );
      }
      st.transport.dispose();
      chain[i] = next;
      // Ahora sí el input actual: seq continúa donde el historial quedó.
      const r = await doStep(t, next, input, seq[i]);
      sent[i].push(input);
      seq[i]++;
      return { shape: input.shape, payload: r.payload };
    }
  }

  // ---------- B5: audit-by-replay (TOPLOC) ----------
  // Post-generación, pre-close: toma el ÚLTIMO ckpt reportado por una
  // sesión del chain y le pide a un SPARE del mismo tramo que recomputé
  // esa ventana — los ins llegan por absorb (coordinator-side si los tiene,
  // replay del predecesor vivo si no). El auditor cierra: sus half-chains
  // recomputan el ckpt — divergir del reportado prueba que el original no
  // corrió el cómputo declarado (pesos distintos, lazy, otro modelo).
  // Sin auditor disponible → skip honesto (audit es best-effort, no gate).
  private async auditByReplay(
    chain: ChainEntry[],
    ckpts: Map<string, { seq: number; hash: string; weights?: string }>,
    insOf: (i: number) => Hidden[] | null,
    jobId: string,
    req: ExecRequest,
  ): Promise<void> {
    if (this.auditRate <= 0 || Math.random() >= this.auditRate) return;
    if (!this.requestStage) return;
    const eligible = chain.map((st, i) => ({ st, i, ck: ckpts.get(st.sessionId) })).filter((e) => e.ck);
    if (!eligible.length) return; // ningún tramo llegó a un ckpt — nada que auditar
    const { st, i: idx, ck } = eligible[Math.floor(Math.random() * eligible.length)] as { st: ChainEntry; i: number; ck: { seq: number; hash: string; weights?: string } };
    const offer = await this.requestStage(st.endpoint, st.blocks, "audit").catch(() => null);
    if (!offer?.endpoint || !offer.blocks) return; // sin spare del tramo → skip honesto
    const t = this.dial(offer.endpoint);
    const auditSid = `${st.sessionId}:audit`;
    try {
      const ack0 = await withTimeout(
        t.open({
          jobId,
          sessionId: auditSid,
          model: req.model,
          blocks: offer.blocks,
          ...(offer.token ? { token: offer.token } : {}),
          ...(this.coordPubkey ? { coordPubkey: this.coordPubkey } : {}),
        }),
        this.stepTimeoutMs,
        `audit ${offer.endpoint} open`,
      );
      // Weights primero: si el auditor cargó otros pesos, el ckpt jamás
      // converge — diagnóstico específico antes de gastar el replay.
      if (ck.weights && ack0.weights && ack0.weights !== ck.weights) {
        throw new Error(
          `B5 audit stage [${st.blocks[0]},${st.blocks[1]}) ${st.endpoint}: weights divergen (reportado ${ck.weights.slice(0, 12)}… vs auditor ${ack0.weights.slice(0, 12)}…) — el tramo no corre los pesos declarados`,
        );
      }
      const creds = {
        ...(offer.token ? { token: offer.token } : {}),
        ...(this.coordPubkey ? { coordPubkey: this.coordPubkey } : {}),
      };
      const ins = insOf(idx);
      if (ins) {
        // Relay / K=0: el coordinator tiene los ins — absorb directo.
        // Si la historia no cubre el ckpt, absorb parcial daría un falso
        // mismatch → skip honesto.
        if (ins.length <= ck.seq || ins.slice(0, ck.seq + 1).some((h) => !h)) return;
        for (let n = 0; n <= ck.seq; n++) {
          const h = ins[n]!;
          t.injectFwd({ sessionId: auditSid, seq: n, shape: h.shape, dtype: "f16", payload: h.payload, ...creds, absorb: true });
        }
      } else {
        // Direct K>0: el predecesor vivo replaya sus outs (los ins del
        // auditado) hasta el ckpt — absorb en la sesión auditora.
        const prev = chain[idx - 1];
        if (!prev?.transport.alive) return; // sin fuente de ins → skip
        await withTimeout(
          prev.transport.replay(prev.sessionId, ck.seq, { endpoint: offer.endpoint, sessionId: auditSid, ...creds }),
          this.stepTimeoutMs,
          `audit replay ${prev.endpoint} → ${offer.endpoint}`,
        );
      }
      // Close → chains finales del auditor = estado a ck.seq (absorb no
      // propaga). El ckpt recomputado debe igualar el reportado.
      const ack = await t.close(auditSid);
      if (!ack.inChain || !ack.outChain) return; // auditor sin chains — skip
      const recomputed = stageCkpt(ck.seq, ack.inChain, ack.outChain);
      if (recomputed !== ck.hash) {
        throw new Error(
          `B5 audit mismatch stage [${st.blocks[0]},${st.blocks[1]}) ${st.endpoint}: ckpt@seq${ck.seq} diverge — cómputo deshonesto`,
        );
      }
    } finally {
      t.dispose();
    }
  }

  // ---------- B2: data plane directo (stage→stage) ----------
  // El coordinator inyecta cada token en s1 y espera el out de sN — los
  // tramos medios corren fuera de banda (N+1 hops por token). El control
  // sigue anclado: reports por seq dan blame/progreso y las sesiones las
  // abre/cierra el coordinator en TODOS los stages (auth B1 intacta).
  private async *executeDirect(req: ExecRequest): AsyncIterable<StreamChunk> {
    const jobId = req.jobId;
    const hop = (e: { endpoint: string; token?: string; sessionId: string }) =>
      ({ endpoint: e.endpoint, sessionId: e.sessionId, ...(e.token ? { token: e.token } : {}), ...(this.coordPubkey ? { coordPubkey: this.coordPubkey } : {}) });
    const chain: ChainEntry[] = this.stages.map((s, i) => ({
      endpoint: s.endpoint,
      blocks: s.blocks,
      token: s.token,
      transport: this.dial(s.endpoint),
      sessionId: `${jobId}:s${i}`,
      // En direct el coordinator no ve los tensores medios — los half-chains
      // viven server-side; los nuestros quedan al seed (los ckpts reales
      // llegan por stage.report → ckpts).
      chain: stageHalfInit(jobId),
      inChain: stageHalfInit(jobId),
      outChain: stageHalfInit(jobId),
    }));
    // B5: ckpts reportados por los stages (TOPLOC) — audit-by-replay.
    const ckpts = new Map<string, { seq: number; hash: string; weights?: string }>();
    const opened = new Set<string>();
    const closed = new Set<string>();
    // injected[n] = input enviado a s1 en seq n — la re-inyección del heal.
    const injected: Hidden[] = [];
    // Progreso reportado por sesión (stage.report) — blame sin adivinar.
    const lastReport = new Map<string, number>();
    const fail: { cur: { sessionId: string; error: string; blame?: string } | null } = { cur: null };
    // Break-signal: un stage.fail o un transport muerto despierta el heal
    // AL INSTANTE — en modo directo el expectOut espera en el stage FINAL
    // (vivo) y no se entera de que la cadena se rompió upstream; esperar el
    // stepTimeout completo por cada corte sería latencia regalada.
    const breaker = {
      fired: null as Error | null,
      cbs: new Set<(e: Error) => void>(),
      fire(e: Error) {
        this.fired ??= e;
        for (const f of this.cbs) f(this.fired);
      },
      wait(): Promise<never> {
        if (this.fired) return Promise.reject(this.fired);
        return new Promise((_r, rej) => this.cbs.add((e) => rej(e)));
      },
      reset() {
        this.fired = null;
        this.cbs.clear();
      },
    };
    const watch = (t: StageTransport) => {
      t.onEvent?.((m) => {
        if (m.type === "stage.report") {
          lastReport.set(m.sessionId, m.seq);
          // B5: el ckpt ata la historia a ese seq — comparable contra la
          // sesión auditora (hash sin sessionId, mismo seed jobId).
          if (m.ckpt) ckpts.set(m.sessionId, { seq: m.ckpt.seq, hash: m.ckpt.hash, ...(m.ckpt.weights ? { weights: m.ckpt.weights } : {}) });
        }
        if (m.type === "stage.fail") {
          fail.cur = { sessionId: m.sessionId, error: m.error, ...(m.blame ? { blame: m.blame } : {}) };
          breaker.fire(new Error(`stage.fail ${m.sessionId}: ${m.error}`));
        }
      });
      t.onDead?.((e) => breaker.fire(e));
    };
    for (const st of chain) watch(st.transport);
    const closeSession = async (st: ChainEntry, collect: StageSig[] | null): Promise<void> => {
      if (!opened.has(st.sessionId) || closed.has(st.sessionId)) return;
      closed.add(st.sessionId);
      const ack = await st.transport.close(st.sessionId);
      if (ack.sig && collect) {
        collect.push({
          endpoint: st.endpoint,
          blocks: st.blocks,
          sessionId: st.sessionId,
          sig: ack.sig,
          ...(ack.inChain ? { inChain: ack.inChain } : {}),
          ...(ack.outChain ? { outChain: ack.outChain } : {}),
        });
      }
    };
    const openOne = async (st: ChainEntry, i: number) => {
      const ack = await withTimeout(
        st.transport.open({
          jobId,
          sessionId: st.sessionId,
          model: req.model,
          blocks: st.blocks,
          kvLenHint: 1024,
          ...(st.token ? { token: st.token } : {}),
          ...(this.coordPubkey ? { coordPubkey: this.coordPubkey } : {}),
          // next: a dónde forwardea este stage — con las credenciales de la
          // sesión destino (courier-auth B1: las porta, no las mintea).
          ...(i < chain.length - 1 ? { next: hop(chain[i + 1]) } : {}),
        }),
        this.stepTimeoutMs,
        `stage ${st.endpoint} open`,
      );
      st.weights = ack.weights;
      opened.add(st.sessionId);
    };
    try {
      for (let i = 0; i < chain.length; i++) await openOne(chain[i], i);
      let cur = await this.front.embed(jobId, req.prompt);
      let genTokens = 0;
      const t0 = Date.now();
      const limit = req.options?.maxTokens ?? this.maxTokens;
      let seq = 0;
      while (genTokens < limit) {
        if (req.signal?.aborted) throw new Error("job cancelado");
        // Inyecta en s1 (fire-and-forget) y espera el out de sN. El inject
        // puede tirar sync si s1 murió (send sobre socket muerto) — mismo
        // camino de heal que un timeout del out.
        let out: Hidden;
        try {
          chain[0].transport.inject({ sessionId: chain[0].sessionId, seq, shape: cur.shape, dtype: "f16", payload: cur.payload });
          injected.push(cur);
          const r = await withTimeout(
            Promise.race([
              chain[chain.length - 1].transport.expectOut(chain[chain.length - 1].sessionId, seq),
              breaker.wait(),
            ]),
            this.stepTimeoutMs,
            `pipeline seq ${seq}`,
          );
          out = { shape: cur.shape, payload: r.payload };
        } catch (e) {
          if (req.signal?.aborted) throw e;
          if (injected.length <= seq) injected.push(cur); // el inject tiró — registrarlo igual
          await this.healDirect(chain, seq, injected, lastReport, fail, watch, jobId, req, opened);
          fail.cur = null;
          breaker.reset(); // el corte ya se heal-eó — la próxima espera arranca limpia
          // El heal ya re-inyectó seq — solo re-esperar el out.
          const r = await withTimeout(
            Promise.race([
              chain[chain.length - 1].transport.expectOut(chain[chain.length - 1].sessionId, seq),
              breaker.wait(),
            ]),
            this.stepTimeoutMs,
            `pipeline seq ${seq} post-heal`,
          );
          out = { shape: cur.shape, payload: r.payload };
        }
        const r = await this.front.next(out);
        if (r.done) break;
        genTokens++;
        yield { token: r.token, done: false };
        cur = r.embed;
        seq++;
      }
      // B5: audit post-generación — en direct los ins viven en el
      // coordinator solo para s1; tramos medios los replaya el predecesor.
      await this.auditByReplay(chain, ckpts, (i) => (i === 0 ? injected : null), jobId, req);
      const stageSigs: StageSig[] = [];
      for (const st of chain) await closeSession(st, stageSigs);
      yield {
        token: "",
        done: true,
        stats: { genTokens, decodeMs: Date.now() - t0, promptTokens: Math.ceil(req.prompt.length / 4) },
        ...(stageSigs.length ? { stageSigs } : {}),
      };
    } finally {
      for (const st of chain) {
        await closeSession(st, null);
        st.transport.dispose();
      }
    }
  }

  // Heal en modo directo: uno o más stages ADYACENTES mueren mid-token —
  // el coordinator no tiene su historial (nunca lo vio), el CACHE del
  // último vivo sí (Petals dual-cache corrido al stage). Cascada:
  //   1. Detectar el set contiguo muerto [lo..hi] alrededor del culpable.
  //   2. requestStage por cada tramo — sin cobertura completa, fail honesto.
  //   3. Open de reemplazos en orden DESCENDENTE: el next de repl_i es
  //      repl_{i+1} (o el vivo chain[hi+1]) — debe existir antes.
  //   4. Replay en cascada ascendente: chain[lo-1] (o `injected` si lo=0)
  //      alimenta a repl_lo por absorb; cada reemplazo —cuyo absorb pobló
  //      su outCache— replaya al siguiente hasta repl_hi.
  //   5. repoint: chain[lo-1] redirige su next a repl_lo.
  //   6. Re-inyectar seq en s1 (o en repl_0 si lo=0): la onda
  //      dedup-redeliver atraviesa los sanos hasta el bloque curado.
  private async healDirect(
    chain: ChainEntry[],
    seq: number,
    injected: Hidden[],
    lastReport: Map<string, number>,
    fail: { cur: { sessionId: string; error: string; blame?: string } | null },
    watch: (t: StageTransport) => void,
    jobId: string,
    req: ExecRequest,
    opened: Set<string>,
  ): Promise<void> {
    if (!this.requestStage) throw new Error("stage murió y no hay requestStage — sin heal");
    const credsOf = (e: { token?: string }) =>
      ({ ...(e.token ? { token: e.token } : {}), ...(this.coordPubkey ? { coordPubkey: this.coordPubkey } : {}) });
    // Culprit — evidencia en orden de precisión:
    //   1. blame explícito: un stage vivo reportó que su NEXT murió (el
    //      fail lleva sessionId del emisor — sin blame culparíamos al vivo).
    //   2. transport coordinator↔stage muerto (evidencia dura).
    //   3. fail propio (sessionId del emisor ES el culpable).
    //   4. menor progreso reportado (straggler cortó la cadena).
    let c = fail.cur?.blame ? chain.findIndex((st) => st.sessionId === fail.cur!.blame) : -1;
    if (c < 0) c = chain.findIndex((st) => !st.transport.alive);
    if (c < 0 && fail.cur) c = chain.findIndex((st) => st.sessionId === fail.cur!.sessionId);
    if (c < 0) {
      let minSeq = Infinity;
      for (const [i, st] of chain.entries()) {
        const r = lastReport.get(st.sessionId) ?? -1;
        if (r < minSeq) {
          minSeq = r;
          c = i;
        }
      }
    }
    if (c < 0) c = 0;
    // B3-cascada con reintento: el set de muertos es el bloque CONTIGUO al
    // culpable — un muerto no puede replayar su cache, la fuente es el
    // último vivo previo a `lo` (o el coordinator si lo=0). Si un stage
    // muere DURANTE el heal (su socket no había reportado aún), el intento
    // falla y se re-detecta con el set ampliado — acotado por chain.length
    // y sin gastar requestStage en tramos ya repuestos (repls reutilizables;
    // el absorb es idempotente por dedup de seqs).
    const repls = new Map<number, ChainEntry>(); // vivos no-commiteados, reusables entre intentos
    let lastErr: unknown = null;
    try {
      for (let attempt = 0; attempt <= chain.length; attempt++) {
        let lo = c;
        while (lo > 0 && !chain[lo - 1].transport.alive) lo--;
        let hi = c;
        while (hi < chain.length - 1 && !chain[hi + 1].transport.alive) hi++;
        try {
          // Reemplazos por tramo — opens en orden DESCENDENTE para que el
          // next de repl_i (repl_{i+1} o el vivo chain[hi+1]) ya exista.
          let nextHop: { endpoint: string; sessionId: string; token?: string } | undefined =
            chain[hi + 1] ? { endpoint: chain[hi + 1].endpoint, sessionId: chain[hi + 1].sessionId, token: chain[hi + 1].token } : undefined;
          for (let i = hi; i >= lo; i--) {
            const kept = repls.get(i);
            if (kept?.transport.alive) {
              // Sobrevivió al intento anterior — su next puede apuntar a un
              // repl_{i+1} DISTINTO (re-creado): repoint al destino actual.
              const moved = nextHop && i < hi
                ? await withTimeout(
                    kept.transport.repoint(kept.sessionId, { endpoint: nextHop.endpoint, sessionId: nextHop.sessionId, ...(nextHop.token ? { token: nextHop.token } : {}), ...(this.coordPubkey ? { coordPubkey: this.coordPubkey } : {}) }),
                    this.stepTimeoutMs,
                    `repoint ${kept.endpoint} → ${nextHop.endpoint}`,
                  ).then(() => true).catch(() => false)
                : true;
              if (moved) {
                nextHop = { endpoint: kept.endpoint, sessionId: kept.sessionId, token: kept.token };
                continue;
              }
              // Sesión zombie en el spare (socket vivo, sesión muerta): no
              // reusable — se repone por el path normal abajo.
              repls.delete(i);
              kept.transport.dispose();
            }
            const dead = chain[i];
            dead.transport.dispose();
            const offer = await this.requestStage(dead.endpoint, dead.blocks).catch(() => null);
            if (!offer?.endpoint || !offer.blocks) {
              throw new Error(`stage ${dead.endpoint} murió sin reemplazo (heal directo)`);
            }
            const t = this.dial(offer.endpoint);
            const sessionId = `${dead.sessionId}r${seq}a${attempt}`;
            await withTimeout(
              t.open({
                jobId,
                sessionId,
                model: req.model,
                blocks: offer.blocks,
                ...credsOf(offer),
                ...(nextHop
                  ? { next: { endpoint: nextHop.endpoint, sessionId: nextHop.sessionId, ...(nextHop.token ? { token: nextHop.token } : {}), ...(this.coordPubkey ? { coordPubkey: this.coordPubkey } : {}) } }
                  : {}),
              }),
              this.stepTimeoutMs,
              `stage ${offer.endpoint} open`,
            );
            const repl: ChainEntry = { endpoint: offer.endpoint, blocks: offer.blocks, token: offer.token, transport: t, sessionId, chain: stageHalfInit(jobId), inChain: stageHalfInit(jobId), outChain: stageHalfInit(jobId) };
            watch(t); // el reemplazo entra al mismo watch de reports/fails
            repls.set(i, repl);
            nextHop = { endpoint: repl.endpoint, sessionId: repl.sessionId, token: repl.token };
          }
          // Historia en cascada ascendente: cada eslabón absorbe los outs
          // del anterior (absorb pobla su outCache → alimenta al siguiente).
          for (let i = lo; i <= hi; i++) {
            const repl = repls.get(i)!;
            if (i === lo && lo === 0) {
              // s1 en el set: el coordinator tiene `injected` — absorb propio.
              for (const [n, h] of injected.slice(0, seq).entries()) {
                repl.transport.injectFwd({ sessionId: repl.sessionId, seq: n, shape: h.shape, dtype: "f16", payload: h.payload, ...credsOf(repl), absorb: true });
              }
            } else {
              const src = i === lo ? chain[lo - 1] : repls.get(i - 1)!;
              await withTimeout(
                src.transport.replay(src.sessionId, seq - 1, { endpoint: repl.endpoint, sessionId: repl.sessionId, ...credsOf(repl) }),
                this.stepTimeoutMs,
                `replay ${src.endpoint} → ${repl.endpoint}`,
              );
            }
          }
          // El último vivo apunta al nuevo tramo de entrada — el bloque
          // muerto sale del data plane antes de la re-inyección.
          if (lo > 0) {
            const prev = chain[lo - 1];
            const repl = repls.get(lo)!;
            await withTimeout(
              prev.transport.repoint(prev.sessionId, { endpoint: repl.endpoint, sessionId: repl.sessionId, ...credsOf(repl) }),
              this.stepTimeoutMs,
              `repoint ${prev.endpoint} → ${repl.endpoint}`,
            );
          }
          for (const [i, repl] of repls) {
            opened.add(repl.sessionId);
            chain[i] = repl;
          }
          // Re-inyectar el token en vuelo — la onda dedup-redeliver lo
          // lleva por los sanos hasta el bloque curado, que computa de verdad.
          const cur = injected[seq];
          if (lo === 0) {
            const repl0 = repls.get(0)!;
            repl0.transport.injectFwd({ sessionId: repl0.sessionId, seq, shape: cur.shape, dtype: "f16", payload: cur.payload, ...credsOf(repl0) });
          } else {
            chain[0].transport.inject({ sessionId: chain[0].sessionId, seq, shape: cur.shape, dtype: "f16", payload: cur.payload });
          }
          return;
        } catch (e) {
          lastErr = e;
          // Otro stage murió mid-heal (o un spare recién probado falló):
          // el próximo intento re-detecta con transport.alive ya en false.
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error("heal directo sin progreso");
    } finally {
      // Reemplazos que no quedaron en la cadena (heal abortado): liberar su
      // socket → el server suelta la sesión (sin esto son sesiones zombie).
      for (const [i, r] of repls) if (chain[i] !== r) r.transport.dispose();
    }
  }
}

// ---------- stage-sim: substrate determinístico para wire-e2e ----------
// Modelo juguete que ejercita TODO el protocolo con bytes reales: el front
// codifica una cola de tokens en el payload; cada stage aplica una marca
// (no identidad — un stage que no transforma no prueba la cadena); el
// front desencola y emite. No es un LLM — es el protocolo end-to-end.

// Front "parrot": el payload es una cola "a|b|c" — cada iteración emite un
// token. El stage transforma (append ":sK") y el front lo quita al final —
// así un stage que no corre deja rastro visible (o rompe el parse → detectable).
export function simFront(): PipelineFront {
  return {
    embed: async (_jobId, prompt) => ({
      shape: [1, prompt.length] as [number, number],
      payload: Buffer.from(prompt.split(" ").join("|")).toString("base64"),
    }),
    async next(hidden) {
      const raw = Buffer.from(hidden.payload, "base64").toString("utf8");
      const cleaned = raw.replace(/:s\d+/g, ""); // los stages marcan; front limpia
      const q = cleaned.split("|").filter(Boolean);
      const tok = q.shift();
      if (tok === undefined) return { done: true };
      return {
        token: `${tok} `,
        done: false,
        embed: { shape: [1, cleaned.length], payload: Buffer.from(q.join("|")).toString("base64") },
      };
    },
  };
}

// Stage-sim server-side: passthrough + marca ":sK" — prueba que el payload
// realmente pasó por ESTE stage (cadena verificable sin pesos reales).
// Guarda la historia de seqs recibidas → el test puede afirmar que el
// reemplazo recibió el REPLAY completo antes del step nuevo.
// sign: la firma del forge (misma key que en job.done) — ata (jobId,
// sessionId, chain) del tramo procesado. Sin signer → close devuelve {}.
export function simStageCompute(
  blocks: [number, number],
  tag = "s0",
  sign?: (preimage: Buffer) => Promise<string> | string,
  // B1 WAN auth: con secret seteado, open exige token HMAC válido —
  // cualquiera sin capability no abre sesión ni toca KV (fail closed).
  secret?: string,
  // B5 test hook: un stage "lazy" altera su output desde este seq — el
  // chain queda consistente (transporte intacto) pero el ckpt diverge del
  // auditor honesto → el audit-by-replay lo atrapa (cómputo, no transporte).
  corruptFromSeq?: number,
) {
  const sess = new Map<string, { blocks: [number, number]; jobId: string; chain: string; inChain: string; outChain: string; seqs: number[] }>();
  // Log de TODOS los seqs recibidos — sobrevive al close (el KV muere con la
  // sesión, pero la evidencia del replay queda para los tests/e2e).
  const seen: { sessionId: string; seq: number }[] = [];
  return {
    open(s: { sessionId: string; jobId: string; blocks: [number, number]; token?: string; coordPubkey?: string }) {
      if (secret && (!s.coordPubkey || !s.token || !stageTokenOk(secret, s.jobId, s.coordPubkey, s.token))) {
        throw new Error("stage.open sin capability válida");
      }
      if (s.blocks[0] < blocks[0] || s.blocks[1] > blocks[1]) {
        throw new Error(`blocks [${s.blocks}] fuera de mi rango [${blocks}]`);
      }
      const seed = stageHalfInit(s.jobId);
      sess.set(s.sessionId, {
        blocks: s.blocks,
        jobId: s.jobId,
        chain: stageChainInit(s.sessionId, s.blocks),
        inChain: seed,
        outChain: seed,
        seqs: [],
      });
    },
    step(s: { sessionId: string; seq: number; payload: string }) {
      const x = sess.get(s.sessionId);
      if (!x) throw new Error("sin sesión — open primero");
      x.seqs.push(s.seq);
      seen.push({ sessionId: s.sessionId, seq: s.seq });
      const out = Buffer.from(
        `${Buffer.from(s.payload, "base64").toString("utf8")}:${tag}${corruptFromSeq !== undefined && s.seq >= corruptFromSeq ? ":corrupt" : ""}`,
      ).toString("base64");
      x.chain = stageChainStep(x.chain, s.seq, s.payload, out);
      x.inChain = stageHalfStep(x.inChain, s.seq, s.payload);
      x.outChain = stageHalfStep(x.outChain, s.seq, out);
      return { payload: out };
    },
    async close(sessionId: string) {
      const x = sess.get(sessionId);
      sess.delete(sessionId);
      if (!x || !sign) return {};
      // v2: la firma ata inChain+outChain — el stage no puede reportar una
      // frontera distinta de la que procesó (gateway cruza in_K+1==out_K).
      return {
        sig: await sign(stageSigPreimageV2(x.jobId, sessionId, x.inChain, x.outChain)),
        inChain: x.inChain,
        outChain: x.outChain,
      };
    },
    sessions: () => sess.size,
    seqsOf: (sessionId: string) => sess.get(sessionId)?.seqs ?? [],
    seenSeqs: () => [...seen],
    // B5: commitment de "pesos" = identidad del tramo — dos daemons del
    // mismo rango declaran el mismo hash (como dos réplicas del mismo
    // checkpoint HF declararían el mismo state_dict hash).
    weightsHash: () => createHash("sha256").update(`w:${tag}:${blocks.join("-")}`, "utf8").digest("hex"),
    chains: (sessionId: string) => {
      const x = sess.get(sessionId);
      return x ? { inChain: x.inChain, outChain: x.outChain } : undefined;
    },
  };
}
