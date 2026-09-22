// Module ForgeExec — TrackedExec (S27): cuenta jobs in-flight por forge.
// Es la única fuente de carga real para el scheduler: queueMs deja de ser una
// constante declarada y pasa a medirse (inFlight × expectedMs en serve.ts).
// El contador vive DENTRO del async generator: execute() es lazy — suma al
// primer next() y resta en finally, así que completar, fallar o cancelar el
// stream siempre libera el slot.
import type { ExecRequest, ForgeExec, ImageExec, ImageRequest, ImageResult, StreamChunk } from "./ports.ts";

export class TrackedExec implements ForgeExec {
  readonly forgeId: string;
  readonly model: string;
  inFlight = 0;
  private readonly inner: ForgeExec;

  constructor(inner: ForgeExec) {
    this.inner = inner;
    this.forgeId = inner.forgeId;
    this.model = inner.model;
  }

  async *execute(req: ExecRequest): AsyncIterable<StreamChunk> {
    this.inFlight++;
    try {
      yield* this.inner.execute(req);
    } finally {
      this.inFlight--;
    }
  }

  probe() {
    return this.inner.probe?.() ?? Promise.resolve(true);
  }

  resident() {
    return this.inner.resident?.() ?? Promise.resolve(true);
  }
}

// Mismo contador para el puerto de imagen (generateImage es Promise, no
// generator — el ++/-- va alrededor del await).
export class TrackedImageExec implements ImageExec {
  readonly forgeId: string;
  readonly model: string;
  inFlight = 0;
  private readonly inner: ImageExec;

  constructor(inner: ImageExec) {
    this.inner = inner;
    this.forgeId = inner.forgeId;
    this.model = inner.model;
  }

  async generateImage(req: ImageRequest): Promise<ImageResult> {
    this.inFlight++;
    try {
      return await this.inner.generateImage(req);
    } finally {
      this.inFlight--;
    }
  }

  probe() {
    return this.inner.probe?.() ?? Promise.resolve(true);
  }
}
