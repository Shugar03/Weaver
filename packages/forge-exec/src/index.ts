// Module ForgeExec — única superficie pública.
export { FakeForgeExec } from "./ports.ts";
export { FailoverForgeExec } from "./failover.ts";
export { OllamaMLXAdapter } from "./ollama.ts";
export { ProvenForgeExec } from "./proven.ts";
export type { ResultSigner } from "./proven.ts";
export { RoutedExec } from "./routed.ts";
export { SwitchableExec } from "./switchable.ts";
export type { ExecRequest, ForgeExec, Proof, StreamChunk } from "./ports.ts";
