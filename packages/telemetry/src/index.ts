// Module Telemetry — única superficie pública.
export { InMemoryTelemetry } from "./ports.ts";
export { PostgresTelemetry } from "./postgres.ts";
export type { Sample, Telemetry } from "./ports.ts";
