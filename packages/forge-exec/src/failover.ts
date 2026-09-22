// Module ForgeExec — FailoverForgeExec: failover en dispatch, error explícito mid-stream.
// Semántica honesta MVP: si el primario muere ANTES del primer token, se prueba el
// siguiente y se mide el reroute (SLA <500ms). Si muere DESPUÉS, se propaga: reintentar
// duplicaría tokens ya enviados, así que el gateway emite evento error y el cliente
// reintenta con Idempotency-Key. Failover silencioso mid-stream = truncar respuestas.
// onForge (S19): reporta por request quién sirvió de verdad (telemetry honesta
// del gateway) — nada de estado compartido entre requests concurrentes.
import type { ExecRequest, ForgeExec, StreamChunk } from "./ports.ts";

export class FailoverForgeExec implements ForgeExec {
  readonly forgeId = "failover";
  readonly model: string;
  lastFailoverMs = 0;
  private readonly execs: ForgeExec[];

  constructor(execs: ForgeExec[]) {
    if (execs.length === 0) throw new Error("failover: sin execs");
    this.execs = execs;
    this.model = execs[0].model;
  }

  async *execute(req: ExecRequest): AsyncIterable<StreamChunk> {
    let lastErr: unknown = null;
    for (const exec of this.execs) {
      const t0 = performance.now();
      let yielded = 0;
      try {
        for await (const chunk of exec.execute(req)) {
          if (yielded === 0) req.onForge?.(exec.forgeId);
          yielded++;
          yield chunk;
        }
        if (yielded === 0) throw new Error(`failover: ${exec.forgeId} vacío`);
        return;
      } catch (err) {
        if (yielded > 0) throw err; // mid-stream: explícito, jamás reintento silencioso
        this.lastFailoverMs = performance.now() - t0;
        lastErr = err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("failover: todos los forges fallaron");
  }
}
