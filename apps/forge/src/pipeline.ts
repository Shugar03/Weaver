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
import { stageChainInit, stageChainStep, stageSigPreimage } from "@weaver/forge-net";
import type { StageDial, StageTransport } from "./stagetransport.ts";

// Frontera de activación entre coordinator y stage.
export type Hidden = { shape: [number, number]; payload: string }; // payload b64

// La mitad local del modelo (inyectable): embed del prompt y logits+sample+embed
// del siguiente token. Prod: llama.cpp head/tail; stage-sim: modelo juguete.
export type PipelineFront = {
  embed(jobId: string, prompt: string): Hidden;
  next(hidden: Hidden): { token: string; done: false; embed: Hidden } | { done: true };
};

// stage.need → stage.offer: el coordinator pide reemplazo al gateway por
// endpoint muerto + tramo a cubrir. null en la respuesta = no hay — fail.
export type StageRequester = (
  dead: string,
  blocks: [number, number],
) => Promise<{ endpoint?: string; blocks?: [number, number] }>;

type ChainEntry = {
  endpoint: string;
  blocks: [number, number];
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
  private readonly stages: { endpoint: string; blocks: [number, number] }[];
  private readonly dial: StageDial;
  private readonly front: PipelineFront;
  private readonly requestStage?: StageRequester;
  private readonly stepTimeoutMs: number;
  private readonly maxTokens: number;

  constructor(deps: {
    forgeId: string;
    model: string;
    stages: { endpoint: string; blocks: [number, number] }[];
    dial: StageDial;
    front: PipelineFront;
    requestStage?: StageRequester;
    stepTimeoutMs?: number;
    maxTokens?: number;
  }) {
    this.forgeId = deps.forgeId;
    this.model = deps.model;
    this.stages = deps.stages;
    this.dial = deps.dial;
    this.front = deps.front;
    this.requestStage = deps.requestStage;
    this.stepTimeoutMs = deps.stepTimeoutMs ?? STEP_TIMEOUT_MS;
    this.maxTokens = deps.maxTokens ?? 512;
  }

  async *execute(req: ExecRequest): AsyncIterable<StreamChunk> {
    const jobId = req.jobId;
    const chain: ChainEntry[] = this.stages.map((s, i) => ({
      endpoint: s.endpoint,
      blocks: s.blocks,
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
      const { sig } = await st.transport.close(st.sessionId);
      if (sig && collect) {
        collect.push({ endpoint: st.endpoint, blocks: st.blocks, sessionId: st.sessionId, chain: st.chain, sig });
      }
    };
    try {
      for (const st of chain) {
        await withTimeout(
          st.transport.open({ jobId, sessionId: st.sessionId, model: req.model, blocks: st.blocks, kvLenHint: 1024 }),
          this.stepTimeoutMs,
          `stage ${st.endpoint} open`,
        );
        st.chain = stageChainInit(st.sessionId, st.blocks);
        opened.add(st.sessionId);
      }
      let cur = this.front.embed(jobId, req.prompt);
      let genTokens = 0;
      const t0 = Date.now();
      const limit = req.options?.maxTokens ?? this.maxTokens;
      while (genTokens < limit) {
        if (req.signal?.aborted) throw new Error("job cancelado");
        for (let i = 0; i < chain.length; i++) {
          cur = await this.step(chain, i, cur, sent, seq, jobId, req, opened);
        }
        const r = this.front.next(cur);
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
        t.open({ jobId, sessionId, model: req.model, blocks: offer.blocks }),
        this.stepTimeoutMs,
        `stage ${offer.endpoint} open`,
      );
      // Swap en la cadena — chain nuevo por sesión (el replay lo repuebla
      // idéntico al que el stage computa server-side).
      const next: ChainEntry = { endpoint: offer.endpoint, blocks: offer.blocks, transport: t, sessionId, chain: stageChainInit(sessionId, offer.blocks) };
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
    embed: (_jobId, prompt) => ({
      shape: [1, prompt.length] as [number, number],
      payload: Buffer.from(prompt.split(" ").join("|")).toString("base64"),
    }),
    next(hidden) {
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
) {
  const sess = new Map<string, { blocks: [number, number]; jobId: string; chain: string; seqs: number[] }>();
  // Log de TODOS los seqs recibidos — sobrevive al close (el KV muere con la
  // sesión, pero la evidencia del replay queda para los tests/e2e).
  const seen: { sessionId: string; seq: number }[] = [];
  return {
    open(s: { sessionId: string; jobId: string; blocks: [number, number] }) {
      if (s.blocks[0] < blocks[0] || s.blocks[1] > blocks[1]) {
        throw new Error(`blocks [${s.blocks}] fuera de mi rango [${blocks}]`);
      }
      sess.set(s.sessionId, { blocks: s.blocks, jobId: s.jobId, chain: stageChainInit(s.sessionId, s.blocks), seqs: [] });
    },
    step(s: { sessionId: string; seq: number; payload: string }) {
      const x = sess.get(s.sessionId);
      if (!x) throw new Error("sin sesión — open primero");
      x.seqs.push(s.seq);
      seen.push({ sessionId: s.sessionId, seq: s.seq });
      const out = Buffer.from(`${Buffer.from(s.payload, "base64").toString("utf8")}:${tag}`).toString("base64");
      x.chain = stageChainStep(x.chain, s.seq, s.payload, out);
      return { payload: out };
    },
    async close(sessionId: string) {
      const x = sess.get(sessionId);
      sess.delete(sessionId);
      if (!x || !sign) return {};
      return { sig: await sign(stageSigPreimage(x.jobId, sessionId, x.chain)) };
    },
    sessions: () => sess.size,
    seqsOf: (sessionId: string) => sess.get(sessionId)?.seqs ?? [],
    seenSeqs: () => [...seen],
  };
}
