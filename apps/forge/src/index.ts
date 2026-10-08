// Module Forge Daemon — superficie pública (ADR-0005): el proceso del
// operador que sirve cómputo real a la red.
export { ForgeDaemon, type DaemonInstance, type PipelineFactory, type StageRequester } from "./daemon.ts";
export { initConfig, loadConfig, type ForgeConfig, type InstanceCfg } from "./config.ts";
export { connect, connectLoop } from "./ws.ts";
// S47 stage-federation (spec 018): transport TCP coordinator↔stage,
// stage-server del worker y PipelineExec del coordinator. El substrate de
// cómputo es inyectable (simStageCompute para wire; block-runner = fase B).
export { tcpStageDial, createStageSocket, type StageTransport, type StageCompute } from "./stagetransport.ts";
export { startStageServer, type StageServer } from "./stageserver.ts";
export { PipelineExec, httpFront, simFront, simStageCompute, type PipelineFront } from "./pipeline.ts";
export { probeTcp } from "./rpcproc.ts";
