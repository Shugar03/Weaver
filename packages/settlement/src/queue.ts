// S43 — SerialQueue: una tx en vuelo por cuenta. Las invokes de Stellar
// compiten por el sequence number de la cuenta origen; settles concurrentes
// producían tx FAILED. La cola los serializa — el orden no importa (los
// settles son fire-and-forget), la no-concurrencia sí.
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.tail.then(fn);
    // La cola sigue aunque una tarea falle — el error viaja al caller.
    this.tail = p.catch(() => {});
    return p;
  }
}
