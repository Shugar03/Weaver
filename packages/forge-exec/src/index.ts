// Module ForgeExec — única superficie pública.
export { FakeForgeExec } from "./ports.ts";
export { FailoverForgeExec } from "./failover.ts";
export { OllamaMLXAdapter } from "./ollama.ts";
export { SwitchableExec } from "./switchable.ts";
export type { ExecRequest, ForgeExec, StreamChunk } from "./ports.ts";
