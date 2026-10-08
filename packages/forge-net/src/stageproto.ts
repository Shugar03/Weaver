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
  // B2 data plane directo: a dónde forwardear la activación de salida.
  // El stage es COURIER de las credenciales del siguiente hop (token
  // HMAC minteado por el daemon del vecino — puede portarlas, no forjarlas).
  // Sin next = último stage: su stage.out va por el socket dueño (coord).
  next?: {
    endpoint: string;
    sessionId: string; // sesión que el coordinator abrió en el siguiente stage
    token?: string;
    coordPubkey?: string;
  };
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
// B2: activación forwardeada stage→stage (salta al coordinator).
// Auth: (token, coordPubkey) deben igualar las credenciales con que se
// abrió la sesión destino — el courier porta, el verificador no distingue
// quién la envía (misma capability = mismo derecho, por diseño).
export type StageFwdMsg = {
  type: "stage.fwd";
  sessionId: string;
  seq: number;
  shape: [number, number];
  dtype: "f16" | "f32" | "q8";
  payload: string; // b64
  token?: string;
  coordPubkey?: string;
  // Replay absorb: computa para reconstruir KV PERO no re-propaga al next
  // ni reporta — los vecinos ya procesaron esos seqs. Sin él, un heal
  // inundaría la cadena con duplicados de tensor completo.
  absorb?: boolean;
};
// B2 heal por stage-cache: el coordinator le dice a un stage VIVO que
// re-inyecte sus outputs cacheados (los inputs del muerto) al reemplazo.
// uptoSeq ausente = todo el historial de la sesión.
export type StageReplayMsg = {
  type: "stage.replay";
  sessionId: string;
  uptoSeq?: number;
  target: {
    endpoint: string;
    sessionId: string;
    token?: string;
    coordPubkey?: string;
  };
};
// B2 heal: redirige el next-hop de una sesión al reemplazo. Solo el dueño
// (socket que la abrió) puede repuntear — es el equivalente en el data
// plane del swap de cadena que el coordinator hace en relay mode.
export type StageRepointMsg = {
  type: "stage.repoint";
  sessionId: string;
  next: {
    endpoint: string;
    sessionId: string;
    token?: string;
    coordPubkey?: string;
  };
};
export type CoordMsg = StageOpenMsg | StageStepMsg | StageCloseMsg | StageFwdMsg | StageReplayMsg | StageRepointMsg;

// ---------- stage → coordinator ----------

// Ack de open y de close. En close-ack, `sig` es la firma del stage sobre
// sha256(jobId:sessionId:chain) — atribución del tramo para stageSigs (A4):
// el coordinator computa el mismo chain sobre el tráfico que observó y el
// gateway verifica sig contra el pubkey del instance asignado (loan).
// Chain canónico (ambas partes computan bytes idénticos):
//   chain₀   = sha256hex(sessionId + ":" + blocks.join("-"))
//   chainₙ₊₁ = sha256hex(chainₙ + ":" + seq + ":" + inB64 + ":" + outB64)
export type StageAckMsg = {
  type: "stage.ack";
  sessionId: string;
  sig?: string;
  // B2: frontera verificable — los half-chains del tramo. Viajan en PAR:
  // inChain_K+1 == outChain_K prueba que toda activación cruzó intacta
  // (checksum async, Petals §3.2). sig v2 = sign(sha256(jobId:sid:in:out)).
  inChain?: string;
  outChain?: string;
  // B5 (TOPLOC): commitment de los PESOS cargados para el tramo — el
  // stage declara sha256(state_dict[k:n]) al abrir. Self-reported: su
  // fuerza es que el audit-by-replay lo contrasta contra un segundo
  // cómputo — mismos ins, mismos pesos honestos → mismo ckpt.
  weights?: string;
};
export type StageOutMsg = {
  type: "stage.out";
  sessionId: string;
  seq: number; // eco del seq del step — el coordinator casa req↔res
  payload: string; // b64
  // Custodia por step (futura): firma por activación — MVP firma al close.
  sig?: string;
};
// blame: sessionId del tramo culpable cuando el fail es ajeno al emisor
// (p.ej. mi fwd al next murió → el culpable es el next, no yo). Sin blame
// el culpable es la propia sesión reportada.
export type StageFailMsg = { type: "stage.fail"; sessionId: string; error: string; blame?: string };
// B2: reporte ligero por step al coordinator (blame + progreso). Bytes,
// no tensor — el data plane va directo, el control sigue anclado al coord.
// B5 ckpt (TOPLOC): cada CKPT_INTERVAL seqs el report ancla un commitment
// sha256("ck":seq:inChain:outChain) — la historia comprimida a ese punto.
// SIN sessionId en el hash: una sesión AUDITORA del mismo tramo produce
// ckpts comparables (audit-by-replay). weights viaja declarado.
export type StageReportMsg = {
  type: "stage.report";
  sessionId: string;
  seq: number;
  ckpt?: { seq: number; hash: string; weights?: string };
};
export type StageMsg = StageAckMsg | StageOutMsg | StageFailMsg | StageReportMsg;

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
const isEndpoint = (v: unknown): v is string => isStr(v) && v.length > 0 && v.length <= 256;
const isSeq = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX_SEQ;
const isDtype = (v: unknown): v is "f16" | "f32" | "q8" => v === "f16" || v === "f32" || v === "q8";
const isToken = (v: unknown): v is string => isStr(v) && v.length <= 256;
const isPubkey = (v: unknown): v is string => isStr(v) && v.length <= 128;
const isHex64 = (v: unknown): v is string => isStr(v) && /^[0-9a-f]{64}$/.test(v);
// Hop destino (open.next / replay.target): endpoint acotado + sessionId +
// credenciales B1 opcionales. Si vienen campos extra se preservan solo los
// conocidos — el courier no gana superficie.
const isHop = (v: unknown): v is { endpoint: string; sessionId: string; token?: string; coordPubkey?: string } => {
  if (!isObj(v) || !isEndpoint(v.endpoint) || !isId(v.sessionId)) return false;
  if (v.token !== undefined && !isToken(v.token)) return false;
  if (v.coordPubkey !== undefined && !isPubkey(v.coordPubkey)) return false;
  return true;
};

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
      if (m.token !== undefined && !isToken(m.token)) return null;
      if (m.coordPubkey !== undefined && !isPubkey(m.coordPubkey)) return null;
      if (m.next !== undefined && !isHop(m.next)) return null;
      return {
        type: "stage.open",
        jobId: m.jobId,
        sessionId: m.sessionId,
        model: m.model,
        blocks: m.blocks,
        ...(isNum(m.kvLenHint) ? { kvLenHint: m.kvLenHint } : {}),
        ...(isStr(m.token) ? { token: m.token } : {}),
        ...(isStr(m.coordPubkey) ? { coordPubkey: m.coordPubkey } : {}),
        ...(isObj(m.next)
          ? {
              next: {
                endpoint: m.next.endpoint as string,
                sessionId: m.next.sessionId as string,
                ...(isStr(m.next.token) ? { token: m.next.token } : {}),
                ...(isStr(m.next.coordPubkey) ? { coordPubkey: m.next.coordPubkey } : {}),
              },
            }
          : {}),
      };
    case "stage.step":
      if (!isId(m.sessionId) || !isSeq(m.seq)) return null;
      if (!isShape(m.shape) || !isB64(m.payload)) return null;
      if (!isDtype(m.dtype)) return null;
      return { type: "stage.step", sessionId: m.sessionId, seq: m.seq as number, shape: m.shape, dtype: m.dtype, payload: m.payload };
    case "stage.fwd":
      if (!isId(m.sessionId) || !isSeq(m.seq)) return null;
      if (!isShape(m.shape) || !isB64(m.payload) || !isDtype(m.dtype)) return null;
      if (m.token !== undefined && !isToken(m.token)) return null;
      if (m.coordPubkey !== undefined && !isPubkey(m.coordPubkey)) return null;
      if (m.absorb !== undefined && m.absorb !== true) return null;
      return {
        type: "stage.fwd",
        sessionId: m.sessionId,
        seq: m.seq as number,
        shape: m.shape,
        dtype: m.dtype,
        payload: m.payload,
        ...(isStr(m.token) ? { token: m.token } : {}),
        ...(isStr(m.coordPubkey) ? { coordPubkey: m.coordPubkey } : {}),
        ...(m.absorb === true ? { absorb: true } : {}),
      };
    case "stage.replay":
      if (!isId(m.sessionId) || !isHop(m.target)) return null;
      if (m.uptoSeq !== undefined && !isSeq(m.uptoSeq)) return null;
      return {
        type: "stage.replay",
        sessionId: m.sessionId,
        ...(isNum(m.uptoSeq) ? { uptoSeq: m.uptoSeq } : {}),
        target: {
          endpoint: m.target.endpoint as string,
          sessionId: m.target.sessionId as string,
          ...(isStr(m.target.token) ? { token: m.target.token } : {}),
          ...(isStr(m.target.coordPubkey) ? { coordPubkey: m.target.coordPubkey } : {}),
        },
      };
    case "stage.repoint":
      if (!isId(m.sessionId) || !isHop(m.next)) return null;
      return {
        type: "stage.repoint",
        sessionId: m.sessionId,
        next: {
          endpoint: m.next.endpoint as string,
          sessionId: m.next.sessionId as string,
          ...(isStr(m.next.token) ? { token: m.next.token } : {}),
          ...(isStr(m.next.coordPubkey) ? { coordPubkey: m.next.coordPubkey } : {}),
        },
      };
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
      // half-chains viajan en PAR — uno solo no prueba ninguna frontera.
      if ((m.inChain === undefined) !== (m.outChain === undefined)) return null;
      if (m.inChain !== undefined && !isHex64(m.inChain)) return null;
      if (m.outChain !== undefined && !isHex64(m.outChain)) return null;
      if (m.weights !== undefined && !isHex64(m.weights)) return null;
      return {
        type: "stage.ack",
        sessionId: m.sessionId,
        ...(isStr(m.sig) ? { sig: m.sig } : {}),
        ...(isStr(m.inChain) ? { inChain: m.inChain } : {}),
        ...(isStr(m.outChain) ? { outChain: m.outChain } : {}),
        ...(isStr(m.weights) ? { weights: m.weights } : {}),
      };
    case "stage.out":
      if (!isId(m.sessionId) || !Number.isInteger(m.seq) || (m.seq as number) < 0 || (m.seq as number) > MAX_SEQ) return null;
      if (!isB64(m.payload)) return null;
      if (m.sig !== undefined && (!isStr(m.sig) || m.sig.length > 256)) return null;
      return { type: "stage.out", sessionId: m.sessionId, seq: m.seq as number, payload: m.payload, ...(isStr(m.sig) ? { sig: m.sig } : {}) };
    case "stage.fail":
      if (!isId(m.sessionId) || !isStr(m.error)) return null;
      if (m.blame !== undefined && !isId(m.blame)) return null;
      return { type: "stage.fail", sessionId: m.sessionId, error: m.error, ...(isStr(m.blame) ? { blame: m.blame } : {}) };
    case "stage.report":
      if (!isId(m.sessionId) || !isSeq(m.seq)) return null;
      if (m.ckpt !== undefined) {
        if (!isObj(m.ckpt) || !isSeq(m.ckpt.seq) || !isHex64(m.ckpt.hash)) return null;
        if (m.ckpt.weights !== undefined && !isHex64(m.ckpt.weights)) return null;
      }
      return {
        type: "stage.report",
        sessionId: m.sessionId,
        seq: m.seq as number,
        ...(isObj(m.ckpt)
          ? {
              ckpt: {
                seq: m.ckpt.seq as number,
                hash: m.ckpt.hash as string,
                ...(isStr(m.ckpt.weights) ? { weights: m.ckpt.weights } : {}),
              },
            }
          : {}),
      };
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

// ---------- boundary chains (B2 transporte directo) ----------
// Half-chains por lado de la frontera: inChain encadena (seq‖in) y outChain
// (seq‖out). El seed es SOLO jobId — compartido por toda la cadena: la
// entrada del stage K+1 en seq n ES la salida del K en seq n, así
// inChain_{K+1} == outChain_K certifica que la frontera cruzó intacta
// (checksum asíncrono de Petals §3.2 — el coordinator no ve el tráfico
// inter-stage en modo directo; los chains se atan entre sí).
// El session-binding NO vive en el seed: lo ata el preimage firmado.
export const stageHalfInit = (jobId: string): string => sha256hex(jobId);

export const stageHalfStep = (chain: string, seq: number, payloadB64: string): string =>
  sha256hex(`${chain}:${seq}:${payloadB64}`);

// Preimage v2: el stage firma AMBOS half-chains — no puede reportar una
// entrada que no produjo su salida ni viceversa.
export const stageSigPreimageV2 = (jobId: string, sessionId: string, inChain: string, outChain: string): Buffer =>
  createHash("sha256").update(`${jobId}:${sessionId}:${inChain}:${outChain}`, "utf8").digest();

// ---------- checkpoint commitments (B5, TOPLOC) ----------
// Cada CKPT_INTERVAL seqs el stage reporta ckpt = sha256("ck":seq:in:out)
// — la historia comprimida a ese punto. El hash NO ata sessionId ni
// weightsHash: una sesión auditora del MISMO tramo, alimentada con los
// mismos inputs por replay-absorb, debe producir el ckpt idéntico si el
// stage original corrió los pesos declarados honestamente. Un stage lazy
// (zeros, truncado, otro modelo) diverge → audit-by-replay lo atrapa.
export const CKPT_INTERVAL = 8;

export const stageCkpt = (seq: number, inChain: string, outChain: string): string =>
  sha256hex(`ck:${seq}:${inChain}:${outChain}`);

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
