// Module benchmarks — única superficie pública.
export { measure, runBench, summarize } from "./runner.ts";
export { DirectTarget, GatewayTarget } from "./targets.ts";
export { sseDataPayloads } from "./sse.ts";
export type { ChatTarget, Chunk, Measurement, Summary } from "./types.ts";
