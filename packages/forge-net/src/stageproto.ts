// S47 — protocolo forge↔forge stage-federation (spec 018 / Petals Algo 1-2).
// Canal SEPARADO del forge↔gateway: el coordinator abre una sesión TCP por
// stage y habla JSON-lines. El stage nunca ve tokens ni prompts — solo
// hidden-states frontera + su rango de bloques (Petals: "server holds a set
// of consecutive transformer blocks").
// Frames JSON, validación estricta — null jamás throw por input remoto.
import { createHash } from "node:crypto";

// ---------- coordinator → stage ----------

// Abre sesión: el stage reserva KV para su rango (server-side, Algo 2).
// B1 (WAN auth): `token` = capability minteada por el daemon DEL WORKER —
// HMAC(secret, jobId:coordPubkey) portado opaco por el gateway. Sin token
// válido un endpoint stage en Internet es atacable por cualquiera (sesiones
// gratis / inyección de activaciones). `coordPubkey` liga el token al
// coordinator que lo presenta — reutilizarlo con otra identidad no sirve.
export type StageOpenMsg = {
  type: "stage.open";
  jobId: string;
  sessionId: string;
  model: string;
  blocks: [number, number]; // rango contiguo que DEBE coincidir con el suyo
  kvLenHint?: number; // tokens esperados — sizing de KV server-side
  token?: string;
  coordPubkey?: string;
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

// Ack de open y de close. En close-ack, `sig` es la firma del stage sobre
// sha256(jobId:sessionId:chain) — atribución del tramo para stageSigs (A4):
// el coordinator computa el mismo chain sobre el tráfico que observó y el
// gateway verifica sig contra el pubkey del instance asignado (loan).
// Chain canónico (ambas partes computan bytes idénticos):
//   chain₀   = sha256hex(sessionId + ":" + blocks.join("-"))
//   chainₙ₊₁ = sha256hex(chainₙ + ":" + seq + ":" + inB64 + ":" + outB64)
export type StageAckMsg = { type: "stage.ack"; sessionId: string; sig?: string };
export type StageOutMsg = {
  type: "stage.out";
  sessionId: string;
  seq: number; // eco del seq del step — el coordinator casa req↔res
  payload: string; // b64
  // Custodia por step (futura): firma por activación — MVP firma al close.
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
      if (m.token !== undefined && (!isStr(m.token) || m.token.length > 256)) return null;
      if (m.coordPubkey !== undefined && (!isStr(m.coordPubkey) || m.coordPubkey.length > 128)) return null;
      return {
        type: "stage.open",
        jobId: m.jobId,
        sessionId: m.sessionId,
        model: m.model,
        blocks: m.blocks,
        ...(isNum(m.kvLenHint) ? { kvLenHint: m.kvLenHint } : {}),
        ...(isStr(m.token) ? { token: m.token } : {}),
        ...(isStr(m.coordPubkey) ? { coordPubkey: m.coordPubkey } : {}),
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
      if (m.sig !== undefined && (!isStr(m.sig) || m.sig.length > 300)) return null;
      return { type: "stage.ack", sessionId: m.sessionId, ...(isStr(m.sig) ? { sig: m.sig } : {}) };
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

// ---------- chain de activaciones (firmable) ----------
// Ambas partes computan el MISMO chain: el stage sobre su sesión, el
// coordinator sobre el tráfico que observó. El sig ata (jobId, sessionId,
// chain) — ni el stage niega su tramo ni el coordinator fabrica la firma.
const sha256hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

export const stageChainInit = (sessionId: string, blocks: [number, number]): string =>
  sha256hex(`${sessionId}:${blocks.join("-")}`);

export const stageChainStep = (chain: string, seq: number, inB64: string, outB64: string): string =>
  sha256hex(`${chain}:${seq}:${inB64}:${outB64}`);

// Lo que el stage firma y el gateway recomputa (Buffer — ed25519/secp256k1).
export const stageSigPreimage = (jobId: string, sessionId: string, chain: string): Buffer =>
  createHash("sha256").update(`${jobId}:${sessionId}:${chain}`, "utf8").digest();

// ---------- capability token (B1 WAN auth) ----------
// HMAC(secret, "jobId|coordPubkey") — el daemon del worker lo mintea al
// recibir stage.grant del gateway; el runner lo verifica con el MISMO
// secret local (WEAVER_STAGE_SECRET). El gateway solo porta el string —
// nunca puede forjarlo ni reescribirlo (no conoce el secret).
import { createHmac, timingSafeEqual } from "node:crypto";

export const stageToken = (secret: string, jobId: string, coordPubkey: string): string =>
  createHmac("sha256", secret).update(`${jobId}|${coordPubkey}`, "utf8").digest("hex");

export const stageTokenOk = (secret: string, jobId: string, coordPubkey: string, token: string): boolean => {
  const a = Buffer.from(token);
  const b = Buffer.from(stageToken(secret, jobId, coordPubkey));
  return a.length === b.length && timingSafeEqual(a, b);
};
