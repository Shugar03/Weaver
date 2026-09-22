// S30 — protocolo forge↔gateway sobre WebSocket (ADR-0005).
// Frames JSON. Validación estricta: un frame malformado devuelve null — el
// caller cierra la sesión, jamás se throwea al proceso por input remoto.
// Nada acá sabe de sockets ni de Stellar: tipos + codec puro.
import type { ExecOptions, ExecStats } from "@weaver/forge-exec";

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
  capability: "text" | "image";
  hot: boolean; // modelo residente AHORA en el engine local del forge
  inFlight: number; // jobs corriendo ahora mismo (medido, no declarado)
  saturated: boolean; // llegó a su cap propio (el forge conoce su límite)
  tokPerSec?: number; // medido en decode real local
  loadTimeMs: number; // carga COLD estimada declarada por el forge
  price?: number; // USD/job que pide el forge (S2 scoring futuro)
};
export type HeartbeatMsg = { type: "heartbeat"; instances: InstanceReport[] };

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
  // Proof L0 viaja por el wire: sha256 del output + firma ed25519 del forge
  // (hex). El gateway NO re-firma — el proof lo emite quien ejecutó.
  resultHash: string;
  signature: string;
};
// midStream=true: falló DESPUÉS de emitir tokens — no reintentable en
// silencio (semántica idéntica al failover local).
export type JobFailMsg = { type: "job.fail"; jobId: string; error: string; midStream: boolean };
export type ImageResultMsg = { type: "image.result"; jobId: string; b64: string; ms: number };
export type PongMsg = { type: "pong"; t: number }; // eco del ping — RTT medido real

export type ForgeMsg =
  | AuthMsg
  | HeartbeatMsg
  | JobAckMsg
  | JobChunkMsg
  | JobDoneMsg
  | JobFailMsg
  | ImageResultMsg
  | PongMsg;

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

export type GatewayMsg = JobAssignMsg | ImageAssignMsg | PingMsg | AuthOkMsg | AuthFailMsg | JobFundedMsg;

// ---------- codec ----------

const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function instanceReport(v: unknown): InstanceReport | null {
  if (!isObj(v)) return null;
  if (!isStr(v.instanceId) || !isStr(v.model)) return null;
  if (v.capability !== "text" && v.capability !== "image") return null;
  if (!isBool(v.hot) || !isNum(v.inFlight) || !isBool(v.saturated) || !isNum(v.loadTimeMs)) return null;
  const r: InstanceReport = {
    instanceId: v.instanceId,
    model: v.model,
    capability: v.capability,
    hot: v.hot,
    inFlight: v.inFlight,
    saturated: v.saturated,
    loadTimeMs: v.loadTimeMs,
  };
  if (isNum(v.tokPerSec)) r.tokPerSec = v.tokPerSec;
  if (isNum(v.price)) r.price = v.price;
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
      if (!Array.isArray(m.instances)) return null;
      const instances = m.instances.map(instanceReport);
      if (instances.some((i) => i === null)) return null;
      return { type: "heartbeat", instances: instances as InstanceReport[] };
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
        ...(isObj(m.stats) ? { stats: m.stats as ExecStats } : {}),
        ...(Array.isArray(m.toolCalls) ? { toolCalls: m.toolCalls as JobDoneMsg["toolCalls"] } : {}),
      };
    case "job.fail":
      if (!isStr(m.jobId) || !isStr(m.error) || !isBool(m.midStream)) return null;
      return { type: "job.fail", jobId: m.jobId, error: m.error, midStream: m.midStream };
    case "image.result":
      if (!isStr(m.jobId) || !isStr(m.b64) || !isNum(m.ms)) return null;
      return { type: "image.result", jobId: m.jobId, b64: m.b64, ms: m.ms };
    case "pong":
      if (!isNum(m.t)) return null;
      return { type: "pong", t: m.t };
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
    default:
      return null;
  }
}

export function encode(msg: ForgeMsg | GatewayMsg): string {
  return JSON.stringify(msg);
}
