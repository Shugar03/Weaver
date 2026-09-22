// S38 — audit replay (ADR-0005): tras un job servido por un remoto, con
// probabilidad AUDIT_RATE re-ejecutamos el prompt canónico (temp 0, 16 tok)
// en ESE forge y en una referencia del mismo modelo (embedded preferida).
// Hash distinto = posible mentira de modelo → strike; 2 seguidos → breaker.
// Falso positivo posible (determinismo cross-engine no garantizado): por eso
// son strikes, no ban inmediato — y el mismatch solo se loguea, no muta ok.
import { createHash } from "node:crypto";
import type { ForgeExec } from "@weaver/forge-exec";
import type { ForgeView } from "@weaver/scheduler";

export const AUDIT_PROMPT = "Reply with exactly: ok";

export type AuditDeps = {
  // Views frescas del fleet (la misma fuente que el routing).
  views: () => Promise<ForgeView[]> | ForgeView[];
  execOf: (forgeId: string) => ForgeExec | undefined;
  breaker: { fail(forgeId: string): void };
  // Testabilidad operativa: cuántos mismatches seguidos tumban al forge.
  maxStrikes?: number;
  // S46: strikes persistentes por pubkey del forge (ForgeStore). Ausente →
  // Map en memoria (tests/dev). Con store, un restart no perdona strikes.
  strikes?: {
    add(pubkey: string): Promise<number>;
    reset(pubkey: string): Promise<void>;
  };
};

export type AuditOutcome = "match" | "mismatch" | "strike-breaker" | "skipped";

export class Auditor {
  private memStrikes = new Map<string, number>();
  private readonly maxStrikes: number;
  private readonly deps: AuditDeps;

  constructor(deps: AuditDeps) {
    this.deps = deps;
    this.maxStrikes = deps.maxStrikes ?? 2;
  }

  // Corre un audit contra `forgeId`. Devuelve el outcome para tests/log —
  // jamás lanza: un auditor roto no puede penalizar al forge ni tumbar el gw.
  async run(forgeId: string, model: string): Promise<AuditOutcome> {
    const views = (await this.deps.views()).filter(
      (f) =>
        f.model === model && (f.capability ?? "text") === "text" &&
        f.attested !== false && f.queueMs < 99_999 && f.saturated !== true,
    );
    const target = views.find((v) => v.forgeId === forgeId);
    // Anti-colusión: la referencia debe ser de OTRO operador. Embedded (sin
    // pubkey = del gateway mismo, confiable) o remoto con pubkey DISTINTA al
    // target. Si el fleet entero del modelo es del mismo operador → skipped:
    // un audit sin referencia independiente no prueba nada.
    const ref =
      views.find((v) => v.forgeId !== forgeId && v.remote !== true) ??
      views.find((v) => v.forgeId !== forgeId && v.forgePubkey !== target?.forgePubkey);
    const tex = target ? this.deps.execOf(target.forgeId) : undefined;
    const rex = ref ? this.deps.execOf(ref.forgeId) : undefined;
    if (!target || !tex || !rex || !ref) return "skipped"; // sin referencia no hay audit honesto
    const [a, b] = await Promise.all([this.hashOf(tex, model), this.hashOf(rex, model)]);
    if (!a || !b) return "skipped"; // el auditor cayó — no penalizar al forge
    // Los strikes viven por PUBKEY (identidad del forge), no por instanceId —
    // un operador no puede resetear su historial renombrando instances.
    const pk = target.forgePubkey ?? forgeId;
    if (a.equals(b)) {
      await this.resetStrikes(pk);
      return "match";
    }
    const n = await this.addStrike(pk);
    console.warn(`audit mismatch: ${forgeId} (${model}) vs ${ref.forgeId} — strike ${n}/${this.maxStrikes}`);
    if (n >= this.maxStrikes) {
      this.deps.breaker.fail(forgeId);
      return "strike-breaker";
    }
    return "mismatch";
  }

  private async addStrike(pk: string): Promise<number> {
    if (this.deps.strikes) {
      try {
        return await this.deps.strikes.add(pk);
      } catch {
        // store caído → memoria (degradado, no ciego)
      }
    }
    const n = (this.memStrikes.get(pk) ?? 0) + 1;
    this.memStrikes.set(pk, n);
    return n;
  }

  private async resetStrikes(pk: string): Promise<void> {
    this.memStrikes.delete(pk);
    await this.deps.strikes?.reset(pk).catch(() => {});
  }

  private async hashOf(ex: ForgeExec, model: string): Promise<Buffer | null> {
    const h = createHash("sha256");
    try {
      for await (const c of ex.execute({
        jobId: `audit-${crypto.randomUUID()}`,
        model,
        prompt: AUDIT_PROMPT,
        options: { maxTokens: 16, temperature: 0 },
      })) {
        if (!c.done) h.update(c.token, "utf8");
        else break;
      }
      return h.digest();
    } catch {
      return null;
    }
  }
}
