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
import type { ExecRequest, ForgeExec, StageSig, StreamChunk } from "@weaver/forge-exec";
import { stageChainInit, stageChainStep, stageHalfInit, stageHalfStep, stageSigPreimage, stageSigPreimageV2, stageTokenOk } from "@weaver/forge-net";
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
    }));
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
        await withTimeout(
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
          cur = await this.step(chain, i, cur, sent, seq, jobId, req, opened);
        }
        const r = await this.front.next(cur);
        if (r.done) break;
        genTokens++;
        yield { token: r.token, done: false };
        cur = r.embed;
      }
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
      chain: stageHalfInit(jobId), // half-chains: el seed es jobId (compartido)
    }));
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
        if (m.type === "stage.report") lastReport.set(m.sessionId, m.seq);
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
      await withTimeout(
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

  // Heal en modo directo: el stage K muere mid-token — el coordinator no
  // tiene el historial de K (nunca lo vio), el CACHE de K-1 sí (Petals
  // dual-cache corrido al stage). Secuencia:
  //   1. requestStage → reemplazo K' (mismo tramo, capability fresca).
  //   2. open K' con el next original de K.
  //   3. replay: K-1 reenvía sus outputs cacheados (los inputs de K) a K'
  //      como absorb-fwd — KV reconstruido sin inundar la cadena.
  //      (K=0: sin previo — el coordinator replaya `injected` él mismo.)
  //   4. repoint: K-1 redirige su next a K' (el muerto sale del data plane).
  //   5. re-inyectar seq actual en s1: la onda dedup-redeliver atraviesa los
  //      stages sanos hasta K', que computa de verdad.
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
    // Culprit — evidencia en orden de precisión:
    //   1. blame explícito: un stage vivo reportó que su NEXT murió (el
    //      fail lleva sessionId del emisor — sin blame culparíamos al vivo).
    //   2. transport coordinator↔stage muerto (evidencia dura).
    //   3. fail propio (sessionId del emisor ES el culpable).
    //   4. menor progreso reportado (straggler cortó la cadena).
    let k = fail.cur?.blame ? chain.findIndex((st) => st.sessionId === fail.cur!.blame) : -1;
    if (k < 0) k = chain.findIndex((st) => !st.transport.alive);
    if (k < 0 && fail.cur) k = chain.findIndex((st) => st.sessionId === fail.cur!.sessionId);
    if (k < 0) {
      let minSeq = Infinity;
      for (const [i, st] of chain.entries()) {
        const r = lastReport.get(st.sessionId) ?? -1;
        if (r < minSeq) {
          minSeq = r;
          k = i;
        }
      }
    }
    if (k < 0) k = 0;
    const dead = chain[k];
    dead.transport.dispose();
    const offer = await this.requestStage(dead.endpoint, dead.blocks).catch(() => null);
    if (!offer?.endpoint || !offer.blocks) {
      throw new Error(`stage ${dead.endpoint} murió sin reemplazo (heal directo)`);
    }
    const t = this.dial(offer.endpoint);
    const sessionId = `${dead.sessionId}r${seq}`;
    const nextHop = k < chain.length - 1
      ? { endpoint: chain[k + 1].endpoint, sessionId: chain[k + 1].sessionId, ...(chain[k + 1].token ? { token: chain[k + 1].token } : {}), ...(this.coordPubkey ? { coordPubkey: this.coordPubkey } : {}) }
      : undefined;
    await withTimeout(
      t.open({
        jobId,
        sessionId,
        model: req.model,
        blocks: offer.blocks,
        ...(offer.token ? { token: offer.token } : {}),
        ...(this.coordPubkey ? { coordPubkey: this.coordPubkey } : {}),
        ...(nextHop ? { next: nextHop } : {}),
      }),
      this.stepTimeoutMs,
      `stage ${offer.endpoint} open`,
    );
    const repl: ChainEntry = { endpoint: offer.endpoint, blocks: offer.blocks, token: offer.token, transport: t, sessionId, chain: stageHalfInit(jobId) };
    watch(t); // el transport del reemplazo entra al mismo watch de reports/fails
    // Replay del historial: el previo tiene los outs (los inputs del muerto).
    if (k > 0) {
      const prev = chain[k - 1];
      await withTimeout(
        prev.transport.replay(prev.sessionId, seq - 1, { endpoint: repl.endpoint, sessionId, ...(repl.token ? { token: repl.token } : {}), ...(this.coordPubkey ? { coordPubkey: this.coordPubkey } : {}) }),
        this.stepTimeoutMs,
        `replay ${prev.endpoint} → ${repl.endpoint}`,
      );
      await withTimeout(
        prev.transport.repoint(prev.sessionId, { endpoint: repl.endpoint, sessionId, ...(repl.token ? { token: repl.token } : {}), ...(this.coordPubkey ? { coordPubkey: this.coordPubkey } : {}) }),
        this.stepTimeoutMs,
        `repoint ${prev.endpoint} → ${repl.endpoint}`,
      );
    } else {
      // s1 muerto: el coordinator tiene `injected` — replay absorb propio.
      for (const [n, h] of injected.slice(0, seq).entries()) {
        t.injectFwd({ sessionId, seq: n, shape: h.shape, dtype: "f16", payload: h.payload, ...(repl.token ? { token: repl.token } : {}), ...(this.coordPubkey ? { coordPubkey: this.coordPubkey } : {}), absorb: true });
      }
    }
    opened.add(sessionId);
    chain[k] = repl;
    // Re-inyectar el token en vuelo en s1 — la onda dedup-redeliver lo lleva
    // hasta K' (los sanos redeliveran cache, K' computa de verdad).
    if (k === 0) {
      const cur = injected[seq];
      t.injectFwd({ sessionId, seq, shape: cur.shape, dtype: "f16", payload: cur.payload, ...(repl.token ? { token: repl.token } : {}), ...(this.coordPubkey ? { coordPubkey: this.coordPubkey } : {}) });
    } else {
      const cur = injected[seq];
      chain[0].transport.inject({ sessionId: chain[0].sessionId, seq, shape: cur.shape, dtype: "f16", payload: cur.payload });
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
      const out = Buffer.from(`${Buffer.from(s.payload, "base64").toString("utf8")}:${tag}`).toString("base64");
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
  };
}
