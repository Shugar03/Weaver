// Module ForgeExec — RoutedExec (S19): la decisión del scheduler ES el dispatch.
// Cada request re-evalúa la fleet (un forge puede morir entre requests) y hace
// failover sobre el orden que dicta `order` — en prod, ETR medido (serve.ts).
// Genérico sobre la vista: forge-exec no conoce ForgeView ni el ETR (sin dep a
// scheduler); el composition root inyecta la política de orden.
import { FailoverForgeExec } from "./failover.ts";
import type { ExecRequest, ForgeExec, StreamChunk } from "./ports.ts";

export class RoutedExec<V extends { forgeId: string; model: string }> implements ForgeExec {
  readonly forgeId = "routed";
  readonly model = "*"; // multi-model: el modelo se elige por request, no por adapter
  private readonly forges: () => V[] | Promise<V[]>;
  private readonly order: (req: ExecRequest, views: V[]) => V[];
  private readonly execs: Record<string, ForgeExec>;

  constructor(deps: {
    forges: () => V[] | Promise<V[]>;
    order: (req: ExecRequest, views: V[]) => V[];
    execs: Record<string, ForgeExec>;
  }) {
    this.forges = deps.forges;
    this.order = deps.order;
    this.execs = deps.execs;
  }

  async *execute(req: ExecRequest): AsyncIterable<StreamChunk> {
    const views = (await this.forges()).filter((v) => v.model === req.model);
    const execs = this.order(req, views)
      .map((v) => this.execs[v.forgeId])
      .filter((e): e is ForgeExec => e !== undefined);
    if (execs.length === 0) throw new Error(`routed: sin execs para ${req.model}`);
    yield* new FailoverForgeExec(execs).execute(req);
  }
}
