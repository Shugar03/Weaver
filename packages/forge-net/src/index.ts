// Module ForgeNet — superficie pública (ADR-0005): protocolo WS, registry
// de forges remotos, remote execs, store de identidades.
export {
  decode,
  decodeGateway,
  encode,
  type AuthMsg,
  type ForgeMsg,
  type GatewayMsg,
  type HeartbeatMsg,
  type ImageAssignMsg,
  type ImageResultMsg,
  type InstanceReport,
  type JobAssignMsg,
  type JobChunkMsg,
  type JobDoneMsg,
  type JobFailMsg,
  type PongMsg,
} from "./protocol.ts";
export { ForgeRegistry, HEARTBEAT_TTL_MS } from "./registry.ts";
export { InMemoryForgeStore, PostgresForgeStore, type ForgeIdentity, type ForgeStore } from "./store.ts";
export { RemoteForgeExec, RemoteImageExec, type DaemonChannel, type ForgeChannel } from "./remote.ts";
export { ForgeSession, type VerifyFn } from "./session.ts";
export { ForgePool, type PoolWorker, type PoolDeps } from "./pool.ts";
export { StagePool, type StageWorker, type StageAssign, type StageChainEntry, type StagePoolDeps } from "./stagepool.ts";
export {
  decodeCoord,
  decodeStage,
  encode as encodeStage,
  stageChainInit,
  stageChainStep,
  stageSigPreimage,
  type CoordMsg,
  type StageMsg,
  type StageOpenMsg,
  type StageStepMsg,
  type StageCloseMsg,
  type StageAckMsg,
  type StageOutMsg,
  type StageFailMsg,
} from "./stageproto.ts";
export { NonceStore } from "./nonce.ts";
export { imageDims } from "./image.ts";
