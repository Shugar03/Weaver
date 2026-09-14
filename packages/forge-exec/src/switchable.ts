// Module ForgeExec — SwitchableExec: envuelve un exec y permite matarlo en vivo.
// Es el chaos switch del dashboard: muerto → execute throwea y el failover salta.
// Sin esto, "KILL FORGE" sería un botón de mentira.
import type { ExecRequest, ForgeExec, StreamChunk } from "./ports.ts";

export class SwitchableExec implements ForgeExec {
  private inner: ForgeExec;
  private dead = false;

  constructor(inner: ForgeExec) {
    this.inner = inner;
  }

  get forgeId(): string {
    return this.inner.forgeId;
  }

  get model(): string {
    return this.inner.model;
  }

  setDead(dead: boolean): void {
    this.dead = dead;
  }

  isDead(): boolean {
    return this.dead;
  }

  async *execute(req: ExecRequest): AsyncIterable<StreamChunk> {
    if (this.dead) throw new Error("forge muerto (chaos)");
    yield* this.inner.execute(req);
  }
}
