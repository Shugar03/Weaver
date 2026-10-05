// Module ForgeExec — única superficie pública.
export { FakeForgeExec } from "./ports.ts";
export { promptHashOf, commitProof } from "./proofhash.ts";
export type { CanonicalMessage } from "./proofhash.ts";
export { FailoverForgeExec } from "./failover.ts";
export { OllamaMLXAdapter } from "./ollama.ts";
export { OpenAICompatAdapter } from "./openaicompat.ts";
export { FluxKleinForge } from "./image.ts";
export { ProvenForgeExec } from "./proven.ts";
export type { ResultSigner } from "./proven.ts";
export { RoutedExec } from "./routed.ts";
export { SwitchableExec } from "./switchable.ts";
export { TrackedExec, TrackedImageExec } from "./tracked.ts";
export type { ExecOptions, ExecRequest, ExecStats, ForgeExec, ImageExec, ImageRequest, ImageResult, Proof, StreamChunk, ToolCall } from "./ports.ts";
