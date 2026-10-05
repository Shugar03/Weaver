// Module ForgeExec — FailoverForgeExec: failover en dispatch + resume mid-stream.
// Pre-token: reintenta el siguiente (SLA <500ms). Mid-stream: el forge muerto
// ya emitió prefijo — el siguiente continúa DESDE ese texto (resume), no se
// trunca ni se duplica. El proof ata solo el sufijo del forge que completó.
// Sin forges vivos para continuar → error explícito, jamás [DONE] falso.
// onForge (S19): reporta por request quién sirvió de verdad — nada de estado
// compartido entre requests concurrentes.
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
    // Prefijo visible ya emitido al cliente — si un forge muere mid-stream,
    // el siguiente recibe resume.prefix y continúa desde acá.
    let prefix = "";
    for (const exec of this.execs) {
      const t0 = performance.now();
      let yielded = 0;
      // think no es parte del output verificable — el prefijo resume solo
      // lleva contenido (mismo criterio que el hash del proof).
      const resumedReq: ExecRequest = prefix ? { ...req, resume: { prefix } } : req;
      try {
        for await (const chunk of exec.execute(resumedReq)) {
          if (yielded === 0) {
            req.onForge?.(exec.forgeId);
            if (prefix) req.onResume?.(exec.forgeId, prefix.length);
          }
          yielded++;
          yield chunk;
          if (!chunk.done && chunk.kind !== "think") prefix += chunk.token;
        }
        if (yielded === 0) throw new Error(`failover: ${exec.forgeId} vacío`);
        return;
      } catch (err) {
        // Cliente desconectado: reintentar en el siguiente forge es trabajo
        // que nadie va a leer. El abort se propaga, no cuenta como falla.
        if (req.signal?.aborted) throw err;
        req.onFail?.(exec.forgeId); // S27: el breaker ve cada intento fallido
        // Si no hay otro forge, agotar con el error real — no inventar éxito.
        if (exec === this.execs[this.execs.length - 1]) {
          throw err instanceof Error ? err : new Error("failover: último forge falló");
        }
        this.lastFailoverMs = performance.now() - t0;
        lastErr = err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("failover: todos los forges fallaron");
  }
}
