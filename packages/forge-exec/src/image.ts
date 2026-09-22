// Adapter de imagen vía mflux (MLX nativo): FLUX.2-klein-4B corre como proceso
// CLI por job — cada request es COLD honesto (load + difusión ≈60-90s), la ETR
// medida por telemetría lo captura sin hacks. Ollama deshabilitó imagegen en
// releases ≥0.32.6 → el forge va directo al runner.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import type { ImageExec, ImageRequest, ImageResult } from "./ports.ts";

export class FluxKleinForge implements ImageExec {
  readonly forgeId: string;
  readonly model: string;
  private readonly timeoutMs: number;
  private dead = false; // chaos switch — mismo contrato que SwitchableExec

  constructor(opts: { forgeId?: string; model?: string; timeoutMs?: number } = {}) {
    this.forgeId = opts.forgeId ?? "image-local";
    this.model = opts.model ?? "flux2-klein-4b";
    this.timeoutMs = opts.timeoutMs ?? 240_000;
  }

  setDead(dead: boolean): void {
    this.dead = dead;
  }

  private static readonly QUANT_PATH = join(homedir(), ".cache", "weaver", "flux2-klein-4b-q4");

  async generateImage(req: ImageRequest): Promise<ImageResult> {
    if (this.dead) throw new Error("forge muerto (chaos)");
    const t0 = performance.now();
    const dir = mkdtempSync(join(tmpdir(), "wvr-img-"));
    const out = join(dir, "out.png");
    const { w, h } = parseSize(req.size);
    try {
      // Pesos pre-cuantizados en disco (mflux-save): carga q4 directa ~3GB,
      // sin el peak de ~10GB de cuantizar bf16 on-load en cada job.
      await spawnCollect("uvx", [
        "--from", "mflux", "mflux-generate-flux2",
        "--model", FluxKleinForge.QUANT_PATH,
        "--base-model", "flux2-klein-4b",
        "--prompt", req.prompt,
        "--output", out,
        "--width", String(w),
        "--height", String(h),
        "--steps", "4",
      ], this.timeoutMs);
      if (!existsSync(out)) throw new Error("mflux terminó sin producir el PNG");
      return { forgeId: this.forgeId, b64: readFileSync(out).toString("base64"), ms: Math.round(performance.now() - t0) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async probe(): Promise<boolean> {
    // Vivo = los pesos q4 pre-cuantizados están en disco (mflux-save ya corrió)
    // y nadie lo mató por chaos.
    return !this.dead && existsSync(FluxKleinForge.QUANT_PATH);
  }
}

function parseSize(size?: string): { w: number; h: number } {
  const m = /^(\d{3,4})x(\d{3,4})$/.exec(size ?? "1024x1024");
  return m ? { w: Number(m[1]), h: Number(m[2]) } : { w: 1024, h: 1024 };
}

function spawnCollect(bin: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    p.stderr.on("data", (d: Buffer) => {
      err = (err + d.toString()).slice(-4000);
    });
    const to = setTimeout(() => {
      p.kill("SIGKILL");
      reject(new Error(`imagegen: timeout ${timeoutMs}ms`));
    }, timeoutMs);
    p.on("error", (e) => {
      clearTimeout(to);
      reject(e);
    });
    p.on("close", (code) => {
      clearTimeout(to);
      if (code === 0) resolve();
      else reject(new Error(`imagegen: exit ${code} ${err.slice(-300)}`));
    });
  });
}
