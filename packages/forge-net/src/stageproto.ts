// S47 — protocolo forge↔forge stage-federation (spec 018 / Petals Algo 1-2).
// Canal SEPARADO del forge↔gateway: el coordinator abre una sesión TCP por
// stage y habla JSON-lines. El stage nunca ve tokens ni prompts — solo
// hidden-states frontera + su rango de bloques (Petals: "server holds a set
// of consecutive transformer blocks").
// Frames JSON, validación estricta — null jamás throw por input remoto.

// ---------- coordinator → stage ----------

// Abre sesión: el stage reserva KV para su rango (server-side, Algo 2).
export type StageOpenMsg = {
  type: "stage.open";
  jobId: string;
  sessionId: string;
  model: string;
  blocks: [number, number]; // rango contiguo que DEBE coincidir con el suyo
  kvLenHint?: number; // tokens esperados — sizing de KV server-side
};
// Un paso de pipeline: activaciones in → el stage corre sus bloques → out.
// payload = hidden states serializados (b64 en MVP; binario/quant = fase B).
export type StageStepMsg = {
  type: "stage.step";
  sessionId: string;
  seq: number; // orden monótono por sesión — el replay lo exige
  shape: [number, number]; // [tokens, hidden]
  dtype: "f16" | "f32" | "q8"; // q8 = dynamic blockwise quant (fase B)
  payload: string; // b64
};
// Cierra sesión — libera el KV. Se manda en done/cancel/disconnect.
export type StageCloseMsg = { type: "stage.close"; sessionId: string };
export type CoordMsg = StageOpenMsg | StageStepMsg | StageCloseMsg;

// ---------- stage → coordinator ----------

export type StageAckMsg = { type: "stage.ack"; sessionId: string };
export type StageOutMsg = {
  type: "stage.out";
  sessionId: string;
  seq: number; // eco del seq del step — el coordinator casa req↔res
  payload: string; // b64
  // Custodia: firma del stage sobre sha256(hashIn‖hashOut‖jobId) — el
  // gateway verifica que cada tramo lo firmó el endpoint asignado (A4).
  sig?: string;
};
export type StageFailMsg = { type: "stage.fail"; sessionId: string; error: string };
export type StageMsg = StageAckMsg | StageOutMsg | StageFailMsg;

// ---------- codec ----------

const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const MAX_BLOCKS = 512;
// 40KB/token × 64-token chunk ≈ 2.5MB crudo → b64 ≈ 3.4MB. Bound holgado pero
// finito: un frame gigante es un DoS contra el stage, no una activación.
const MAX_B64 = 6_000_000;
const MAX_SEQ = 1_000_000;
const isId = (v: unknown): v is string => isStr(v) && v.length > 0 && v.length <= 128;
const isB64 = (v: unknown): v is string => isStr(v) && v.length <= MAX_B64 && /^[A-Za-z0-9+/]*={0,2}$/.test(v);
const isBlocks = (v: unknown): v is [number, number] =>
  Array.isArray(v) && v.length === 2 && Number.isInteger(v[0]) && Number.isInteger(v[1]) &&
  (v[0] as number) >= 0 && (v[1] as number) > (v[0] as number) && (v[1] as number) <= MAX_BLOCKS;
const isShape = (v: unknown): v is [number, number] =>
  Array.isArray(v) && v.length === 2 && Number.isInteger(v[0]) && Number.isInteger(v[1]) &&
  (v[0] as number) >= 1 && (v[0] as number) <= 4096 &&
  (v[1] as number) >= 1 && (v[1] as number) <= 1_000_000;

// Mensajes coordinator→stage (lado stage).
export function decodeCoord(raw: string): CoordMsg | null {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(m) || !isStr(m.type)) return null;
  switch (m.type) {
    case "stage.open":
      if (!isId(m.jobId) || !isId(m.sessionId) || !isId(m.model) || !isBlocks(m.blocks)) return null;
      if (m.kvLenHint !== undefined && (!Number.isInteger(m.kvLenHint) || (m.kvLenHint as number) < 0 || (m.kvLenHint as number) > 1_000_000)) return null;
      return {
        type: "stage.open",
        jobId: m.jobId,
        sessionId: m.sessionId,
        model: m.model,
        blocks: m.blocks,
        ...(isNum(m.kvLenHint) ? { kvLenHint: m.kvLenHint } : {}),
      };
    case "stage.step":
      if (!isId(m.sessionId) || !Number.isInteger(m.seq) || (m.seq as number) < 0 || (m.seq as number) > MAX_SEQ) return null;
      if (!isShape(m.shape) || !isB64(m.payload)) return null;
      if (m.dtype !== "f16" && m.dtype !== "f32" && m.dtype !== "q8") return null;
      return { type: "stage.step", sessionId: m.sessionId, seq: m.seq as number, shape: m.shape, dtype: m.dtype, payload: m.payload };
    case "stage.close":
      if (!isId(m.sessionId)) return null;
      return { type: "stage.close", sessionId: m.sessionId };
    default:
      return null;
  }
}

// Mensajes stage→coordinator (lado coordinator).
export function decodeStage(raw: string): StageMsg | null {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(m) || !isStr(m.type)) return null;
  switch (m.type) {
    case "stage.ack":
      if (!isId(m.sessionId)) return null;
      return { type: "stage.ack", sessionId: m.sessionId };
    case "stage.out":
      if (!isId(m.sessionId) || !Number.isInteger(m.seq) || (m.seq as number) < 0 || (m.seq as number) > MAX_SEQ) return null;
      if (!isB64(m.payload)) return null;
      if (m.sig !== undefined && (!isStr(m.sig) || m.sig.length > 256)) return null;
      return { type: "stage.out", sessionId: m.sessionId, seq: m.seq as number, payload: m.payload, ...(isStr(m.sig) ? { sig: m.sig } : {}) };
    case "stage.fail":
      if (!isId(m.sessionId) || !isStr(m.error)) return null;
      return { type: "stage.fail", sessionId: m.sessionId, error: m.error };
    default:
      return null;
  }
}

export function encode(msg: CoordMsg | StageMsg): string {
  return JSON.stringify(msg);
}
