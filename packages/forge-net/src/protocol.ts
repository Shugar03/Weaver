// S30 — protocolo forge↔gateway sobre WebSocket (ADR-0005).
// Frames JSON. Validación estricta: un frame malformado devuelve null — el
// caller cierra la sesión, jamás se throwea al proceso por input remoto.
// Nada acá sabe de sockets ni de Stellar: tipos + codec puro.
import type { ExecOptions, ExecStats, StageSig } from "@weaver/forge-exec";

// ---------- daemon → gateway ----------

// auth: primer mensaje obligatorio del WS. nonce = challenge REST previo,
// signature = firma ed25519 del pubkey sobre el nonce (hex ambos).
export type AuthMsg = { type: "auth"; pubkey: string; nonce: string; signature: string };

// Capacidad REAL por ModelInstance — el forge la mide localmente
// (TrackedExec/resident de sus adapters). Self-report honesto: el gateway
// no confía ciegamente (attestation + audits), pero la métrica nace acá.
export type InstanceReport = {
  instanceId: string;
  model: string;
  capability: "text" | "image" | "rpc-worker" | "stage-worker";
  hot: boolean; // modelo residente AHORA en el engine local del forge
  inFlight: number; // jobs corriendo ahora mismo (medido, no declarado)
  saturated: boolean; // llegó a su cap propio (el forge conoce su límite)
  tokPerSec?: number; // medido en decode real local
  loadTimeMs: number; // carga COLD estimada declarada por el forge
  price?: number; // USD/job que pide el forge (S2 scoring futuro)
  // S46 pool-forge (spec 017): rpc-worker presta VRAM vía ggml-rpc-server —
  // el gateway solo revela `rpc.endpoint` al coordinator dentro de job.assign.
  rpc?: { endpoint: string; vramGb?: number };
  // coordinator pooled: "este modelo lo sirvo SOLO si me parkean N workers".
  // minVramGb: VRAM mínima por worker — un worker de 2GB no sirve para un 70B
  // aunque sea "uno de cuatro" (el pairing lo filtra, no lo descubre al fallar).
  pool?: { needs: number; minVramGb?: number };
  // S47 stage-federation (spec 018): stage-worker hospeda bloques contiguos
  // [k,n) del modelo y procesa hidden-states (nunca ve tokens ni prompts).
  // endpoint: canal forge→forge que el coordinator diala para stage.open/step.
  // layers es SIEMPRE contiguo (Petals §3.3: split rompe latencia).
  stage?: { layers: [number, number]; endpoint: string; vramGb?: number; tps?: number };
  // coordinator federado: "sirvo este modelo si me armás una cadena que cubra
  // [0..blocks)" — el gateway paira stage-workers por rango de bloques.
  pipeline?: { blocks: number };
};
// agentId: identidad ERC-8004 del forge (EVM, opcional — forges Stellar no
// la tienen). Va a nivel heartbeat, no por instance: es del dueño, no del slot.
export type HeartbeatMsg = { type: "heartbeat"; instances: InstanceReport[]; agentId?: number };

// Streaming de un job de texto — espejo del ForgeExec local.
export type JobAckMsg = { type: "job.ack"; jobId: string }; // aceptó el assign (timeout sin ack = saturado/caido)
export type JobChunkMsg = { type: "job.chunk"; jobId: string; token: string; kind?: "think" | "content" };
export type JobDoneMsg = {
  type: "job.done";
  jobId: string;
  stats?: ExecStats;
  // Tool calls del engine viajan en el done — paridad con StreamChunk local:
  // el gateway las ejecuta y re-envía con role:"tool" (multi-hop remoto).
  toolCalls?: { name: string; arguments: Record<string, unknown> }[];
  // Proof L0 viaja por el wire: firma del forge (hex) sobre el commitment
  // sha256(promptHash‖outputHash) — resultHash ES ese commitment. promptHash
  // y outputHash viajan para verificación transparente; forges legacy mandan
  // resultHash = sha256(output) sin los campos extra (gateway acepta ambos).
  resultHash: string;
  promptHash?: string;
  outputHash?: string;
  signature: string;
  // S47 A4: atribución por tramo — el coordinator recolecta la firma de cada
  // stage al close. El gateway verifica endpoint→signer contra el loan del
  // StagePool y solo reenvía las que verifican.
  stageSigs?: StageSig[];
};
// midStream=true: falló DESPUÉS de emitir tokens — no reintentable en
// silencio (semántica idéntica al failover local).
export type JobFailMsg = {
  type: "job.fail";
  jobId: string;
  error: string;
  midStream: boolean;
  // S46: el fallo fue por los PEERS (pooled spawn / worker endpoint) — el
  // gateway los penaliza para no re-parkearlos. Ausente = culpa del forge.
  poolBlame?: boolean;
};
export type ImageResultMsg = { type: "image.result"; jobId: string; b64: string; ms: number };
export type PongMsg = { type: "pong"; t: number }; // eco del ping — RTT medido real
// S47: el coordinator pide reemplazo de un stage muerto mid-job. El pool del
// gateway es la única autoridad de leases — sin esto el coordinator tendría
// que adivinar endpoints (split-brain de préstamos).
export type StageNeedMsg = { type: "stage.need"; jobId: string; dead: string; blocks: [number, number] };
// B1 (WAN auth): el gateway le pide al daemon del worker un capability
// token para un stage.loan — el worker mintea HMAC(secret, jobId|coordPubkey)
// y lo devuelve por stage.token; el gateway lo porta al coordinator.
export type StageTokenMsg = { type: "stage.token"; jobId: string; stageInstanceId: string; token: string };

export type ForgeMsg =
  | AuthMsg
  | HeartbeatMsg
  | JobAckMsg
  | JobChunkMsg
  | JobDoneMsg
  | JobFailMsg
  | ImageResultMsg
  | PongMsg
  | StageNeedMsg
  | StageTokenMsg;

// ---------- gateway → daemon ----------

export type JobAssignMsg = {
  type: "job.assign";
  jobId: string;
  instanceId: string;
  model: string;
  prompt: string;
  messages?: { role: string; content: string; tool_calls?: unknown; name?: string }[];
  options?: ExecOptions;
  tools?: unknown[];
  // Mid-stream resume: prefijo visible ya servido por un forge que murió —
  // el daemon lo pasa al exec para continuar desde ahí, y entra al
  // promptHash canónico (el proof ata "continuó desde este texto").
  resume?: { prefix: string };
  // S46 pool-forge: endpoints "host:port" de rpc-workers elegidos por el
  // gateway — el daemon spawnea el engine con --rpc peers. Solo viaja al
  // coordinator asignado; jamás sale en API pública.
  rpcPeers?: string[];
  // S47 stage-federation: cadena ORDENADA de stage-workers — el daemon arma
  // PipelineExec (embeddings+lmhead locales, stages remotos por rango).
  // token = capability B1 minteada por el daemon del worker (HMAC opaco).
  stages?: { endpoint: string; blocks: [number, number]; token?: string }[];
};
export type ImageAssignMsg = {
  type: "image.assign";
  jobId: string;
  instanceId: string;
  model: string;
  prompt: string;
  size?: string;
};
export type PingMsg = { type: "ping"; t: number }; // el gateway mide RTT real
export type AuthOkMsg = { type: "auth.ok"; pubkey: string };
export type AuthFailMsg = { type: "auth.fail"; error: string };
// S42 (I4): el release del operador falló post-fund — el job quedó fondeado
// on-chain ligado a ESTE worker. El daemon puede self-claimear firmando el
// resultHash de nuevo (la firma del proof no expira).
export type JobFundedMsg = { type: "job.funded"; chainJobId: number; resultHash: string };
// El consumidor del stream abortó (cliente se fue): libera el cómputo del
// forge YA — sin esto el daemon terminaba el job en vacío quemando GPU.
export type JobCancelMsg = { type: "job.cancel"; jobId: string };
// S47: respuesta a stage.need — endpoint+blocks del reemplazo, o ausentes
// (null honesto: no hay stage que cubra ese tramo → el coordinator falla).
// token = capability B1 para abrir la sesión en ese stage (lo minteó el
// daemon del worker, el gateway solo lo porta).
export type StageOfferMsg = {
  type: "stage.offer";
  jobId: string;
  endpoint?: string;
  blocks?: [number, number];
  token?: string;
};
// B1: el gateway le pide al daemon del WORKER un token para este loan —
// va por el canal autenticado del worker (el coordinator nunca lo toca).
export type StageGrantMsg = {
  type: "stage.grant";
  jobId: string;
  stageInstanceId: string; // qué instance del worker está siendo prestada
  coordPubkey: string; // ligada al coordinator que la va a presentar
};

export type GatewayMsg =
  | JobAssignMsg
  | ImageAssignMsg
  | PingMsg
  | AuthOkMsg
  | AuthFailMsg
  | JobFundedMsg
  | JobCancelMsg
  | StageOfferMsg
  | StageGrantMsg;

// ---------- codec ----------

const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// Bounds anti-abuse (P0-4): un daemon es UNA máquina — máx 16 instances por
// heartbeat (cada una dispara attestation real en el gateway). ids/models
// ≤128 chars y los numéricos que alimentan al scheduler en rangos creíbles:
// un price negativo o tokPerSec absurdo sesgaba selección y billing.
const MAX_INSTANCES = 16;
const isId = (v: unknown): v is string => isStr(v) && v.length > 0 && v.length <= 128;
const inRange = (v: unknown, lo: number, hi: number): v is number => isNum(v) && v >= lo && v <= hi;
// "host:port" — host sin espacios ni ':' (IPv6 va entre corchetes), puerto 1-65535
const isEndpoint = (v: unknown): v is string =>
  isStr(v) && v.length <= 255 && /^\[[0-9a-fA-F:]+\]:\d{1,5}$|^[^\s:\[\]]{1,253}:\d{1,5}$/.test(v) &&
  Number(v.slice(v.lastIndexOf(":") + 1)) >= 1 && Number(v.slice(v.lastIndexOf(":") + 1)) <= 65535;
const MAX_RPC_PEERS = 4; // un pipeline no es un enjambre — boundary count acotado
const MAX_STAGES = 6; // cadena acotada: cada frontera suma RTT por token
const MAX_BLOCKS = 512; // n_layer del transformer más grande conocido (~DeepSeek 61, Qwen3-235B 94)
const isLayers = (v: unknown): v is [number, number] =>
  Array.isArray(v) && v.length === 2 &&
  Number.isInteger(v[0]) && Number.isInteger(v[1]) &&
  (v[0] as number) >= 0 && (v[1] as number) > (v[0] as number) && (v[1] as number) <= MAX_BLOCKS;
// stageSigs: ≤ MAX_STAGES+1 entradas (un reemplazo puede sumar una sesión
// firmada extra). chain = sha256 hex fijo; sig = ed25519/secp256k1 hex.
const isStageSigs = (v: unknown): v is StageSig[] =>
  Array.isArray(v) && v.length > 0 && v.length <= MAX_STAGES + 1 &&
  v.every(
    (s) =>
      isObj(s) && isEndpoint(s.endpoint) && isLayers(s.blocks) &&
      isId(s.sessionId) &&
      isStr(s.chain) && /^[0-9a-f]{64}$/.test(s.chain) &&
      isStr(s.sig) && /^[0-9a-fA-F]{128,300}$/.test(s.sig),
  );

function instanceReport(v: unknown): InstanceReport | null {
  if (!isObj(v)) return null;
  if (!isId(v.instanceId) || !isId(v.model)) return null;
  if (v.capability !== "text" && v.capability !== "image" && v.capability !== "rpc-worker" && v.capability !== "stage-worker") return null;
  if (!isBool(v.hot) || !inRange(v.inFlight, 0, 1024) || !isBool(v.saturated) || !inRange(v.loadTimeMs, 0, 600_000)) return null;
  const r: InstanceReport = {
    instanceId: v.instanceId,
    model: v.model,
    capability: v.capability,
    hot: v.hot,
    inFlight: v.inFlight,
    saturated: v.saturated,
    loadTimeMs: v.loadTimeMs,
  };
  if (isNum(v.tokPerSec)) {
    if (!inRange(v.tokPerSec, 0, 10_000)) return null;
    r.tokPerSec = v.tokPerSec;
  }
  if (isNum(v.price)) {
    if (!inRange(v.price, 0, 1_000_000)) return null;
    r.price = v.price;
  }
  // rpc-worker exige endpoint — sin él el gateway no puede parkearla.
  if (v.capability === "rpc-worker") {
    if (!isObj(v.rpc) || !isEndpoint(v.rpc.endpoint)) return null;
    r.rpc = { endpoint: v.rpc.endpoint };
    if (v.rpc.vramGb !== undefined) {
      if (!inRange(v.rpc.vramGb, 0, 2048)) return null;
      r.rpc.vramGb = v.rpc.vramGb;
    }
  }
  if (v.pool !== undefined) {
    if (!isObj(v.pool) || !isNum(v.pool.needs) || !Number.isInteger(v.pool.needs) || v.pool.needs < 1 || v.pool.needs > MAX_RPC_PEERS) return null;
    r.pool = { needs: v.pool.needs };
    if (v.pool.minVramGb !== undefined) {
      if (!inRange(v.pool.minVramGb, 1, 2048)) return null;
      r.pool.minVramGb = v.pool.minVramGb;
    }
  }
  // stage-worker exige `stage` — sin rango/endpoint no es parkeable.
  if (v.capability === "stage-worker") {
    if (!isObj(v.stage) || !isLayers(v.stage.layers) || !isEndpoint(v.stage.endpoint)) return null;
    r.stage = { layers: v.stage.layers, endpoint: v.stage.endpoint };
    if (v.stage.vramGb !== undefined) {
      if (!inRange(v.stage.vramGb, 0, 2048)) return null;
      r.stage.vramGb = v.stage.vramGb;
    }
    if (v.stage.tps !== undefined) {
      if (!inRange(v.stage.tps, 0, 10_000)) return null;
      r.stage.tps = v.stage.tps;
    }
  }
  if (v.pipeline !== undefined) {
    if (!isObj(v.pipeline) || !Number.isInteger(v.pipeline.blocks) || (v.pipeline.blocks as number) < 2 || (v.pipeline.blocks as number) > MAX_BLOCKS) return null;
    r.pipeline = { blocks: v.pipeline.blocks as number };
  }
  return r;
}

// Decodifica SOLO mensajes daemon→gateway (el daemon usa decodeGateway).
export function decode(raw: string): ForgeMsg | null {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(m) || !isStr(m.type)) return null;
  switch (m.type) {
    case "auth":
      if (!isStr(m.pubkey) || !isStr(m.nonce) || !isStr(m.signature)) return null;
      return { type: "auth", pubkey: m.pubkey, nonce: m.nonce, signature: m.signature };
    case "heartbeat": {
      if (!Array.isArray(m.instances) || m.instances.length > MAX_INSTANCES) return null;
      const instances = m.instances.map(instanceReport);
      if (instances.some((i) => i === null)) return null;
      if (m.agentId !== undefined && !isNum(m.agentId)) return null;
      return {
        type: "heartbeat",
        instances: instances as InstanceReport[],
        ...(isNum(m.agentId) ? { agentId: m.agentId } : {}),
      };
    }
    case "job.ack":
      if (!isStr(m.jobId)) return null;
      return { type: "job.ack", jobId: m.jobId };
    case "job.chunk":
      if (!isStr(m.jobId) || !isStr(m.token)) return null;
      if (m.kind !== undefined && m.kind !== "think" && m.kind !== "content") return null;
      return { type: "job.chunk", jobId: m.jobId, token: m.token, ...(m.kind ? { kind: m.kind } : {}) };
    case "job.done":
      if (!isStr(m.jobId) || !isStr(m.resultHash) || !isStr(m.signature)) return null;
      return {
        type: "job.done",
        jobId: m.jobId,
        resultHash: m.resultHash,
        signature: m.signature,
        ...(isStr(m.promptHash) ? { promptHash: m.promptHash } : {}),
        ...(isStr(m.outputHash) ? { outputHash: m.outputHash } : {}),
        ...(isObj(m.stats) ? { stats: m.stats as ExecStats } : {}),
        ...(Array.isArray(m.toolCalls) ? { toolCalls: m.toolCalls as JobDoneMsg["toolCalls"] } : {}),
        ...(isStageSigs(m.stageSigs) ? { stageSigs: m.stageSigs } : {}),
      };
    case "job.fail":
      if (!isStr(m.jobId) || !isStr(m.error) || !isBool(m.midStream)) return null;
      if (m.poolBlame !== undefined && !isBool(m.poolBlame)) return null;
      return { type: "job.fail", jobId: m.jobId, error: m.error, midStream: m.midStream, ...(m.poolBlame === true ? { poolBlame: true } : {}) };
    case "image.result":
      if (!isStr(m.jobId) || !isStr(m.b64) || !isNum(m.ms)) return null;
      return { type: "image.result", jobId: m.jobId, b64: m.b64, ms: m.ms };
    case "pong":
      if (!isNum(m.t)) return null;
      return { type: "pong", t: m.t };
    case "stage.need":
      if (!isStr(m.jobId) || !isStr(m.dead) || !isLayers(m.blocks)) return null;
      return { type: "stage.need", jobId: m.jobId, dead: m.dead, blocks: m.blocks };
    case "stage.token":
      if (!isStr(m.jobId) || !isStr(m.stageInstanceId) || !isStr(m.token) || (m.token as string).length > 256) return null;
      return { type: "stage.token", jobId: m.jobId, stageInstanceId: m.stageInstanceId, token: m.token };
    default:
      return null;
  }
}

// Mensajes gateway→daemon (lado daemon).
export function decodeGateway(raw: string): GatewayMsg | null {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(m) || !isStr(m.type)) return null;
  switch (m.type) {
    case "job.assign":
      if (!isStr(m.jobId) || !isStr(m.instanceId) || !isStr(m.model) || !isStr(m.prompt)) return null;
      if (m.rpcPeers !== undefined && (!Array.isArray(m.rpcPeers) || m.rpcPeers.length > MAX_RPC_PEERS || !m.rpcPeers.every(isEndpoint))) return null;
      if (m.stages !== undefined &&
        (!Array.isArray(m.stages) || m.stages.length > MAX_STAGES ||
         !m.stages.every((s) => isObj(s) && isEndpoint(s.endpoint) && isLayers(s.blocks) &&
           (s.token === undefined || (isStr(s.token) && (s.token as string).length <= 256))))) return null;
      return m as unknown as JobAssignMsg;
    case "image.assign":
      if (!isStr(m.jobId) || !isStr(m.instanceId) || !isStr(m.model) || !isStr(m.prompt)) return null;
      if (m.size !== undefined && !isStr(m.size)) return null;
      return { type: "image.assign", jobId: m.jobId, instanceId: m.instanceId, model: m.model, prompt: m.prompt, ...(isStr(m.size) ? { size: m.size } : {}) };
    case "ping":
      if (!isNum(m.t)) return null;
      return { type: "ping", t: m.t };
    case "auth.ok":
      if (!isStr(m.pubkey)) return null;
      return { type: "auth.ok", pubkey: m.pubkey };
    case "auth.fail":
      if (!isStr(m.error)) return null;
      return { type: "auth.fail", error: m.error };
    case "job.funded":
      if (!isNum(m.chainJobId) || !isStr(m.resultHash)) return null;
      return { type: "job.funded", chainJobId: m.chainJobId, resultHash: m.resultHash };
    case "job.cancel":
      if (!isStr(m.jobId)) return null;
      return { type: "job.cancel", jobId: m.jobId };
    case "stage.offer":
      if (!isStr(m.jobId)) return null;
      if (m.endpoint !== undefined && !isEndpoint(m.endpoint)) return null;
      if (m.blocks !== undefined && !isLayers(m.blocks)) return null;
      if (m.token !== undefined && (!isStr(m.token) || (m.token as string).length > 256)) return null;
      return {
        type: "stage.offer",
        jobId: m.jobId,
        ...(isStr(m.endpoint) ? { endpoint: m.endpoint } : {}),
        ...(isLayers(m.blocks) ? { blocks: m.blocks } : {}),
        ...(isStr(m.token) ? { token: m.token } : {}),
      };
    case "stage.grant":
      if (!isStr(m.jobId) || !isStr(m.stageInstanceId) || !isStr(m.coordPubkey) || (m.coordPubkey as string).length > 128) return null;
      return { type: "stage.grant", jobId: m.jobId, stageInstanceId: m.stageInstanceId, coordPubkey: m.coordPubkey };
    default:
      return null;
  }
}

export function encode(msg: ForgeMsg | GatewayMsg): string {
  return JSON.stringify(msg);
}
