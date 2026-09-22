// S39 — probes de budget del daemon (ADR-0005, modo oportunista).
// idleMs: cuánto lleva idle la máquina (input del usuario). maxVram: cuánta
// VRAM está usando el engine AHORA. Ambos devuelven null si no se pueden
// medir — el caller decide conservador (no medible = no se ofrece como idle).
import { execFile } from "node:child_process";
import { platform } from "node:os";

// macOS: HIDIdleTime del IOHIDSystem (ns → ms). Linux/otros: null — sin
// medición honesta no se declara idle (idleOnly se comporta seguro).
export function osIdleMs(): Promise<number | null> {
  if (platform() !== "darwin") return Promise.resolve(null);
  return new Promise((res) => {
    execFile("ioreg", ["-c", "IOHIDSystem", "-d", "1"], { timeout: 3000 }, (err, out) => {
      if (err) return res(null);
      const m = out.match(/"HIDIdleTime" = (\d+)/);
      res(m ? Number(m[1]) / 1_000_000 : null);
    });
  });
}

// VRAM en uso por Ollama (GB): suma size_vram de /api/ps — incluye modelos
// cargados por OTROS procesos que comparten el engine (budget del forge es
// sobre la máquina, no sobre sus propias instances).
export async function ollamaVramUsedGb(baseUrl = "http://localhost:11434"): Promise<number | null> {
  try {
    const r = await fetch(`${baseUrl}/api/ps`);
    const { models } = (await r.json()) as { models: { size_vram?: number }[] };
    return models.reduce((a, m) => a + (m.size_vram ?? 0), 0) / 1e9;
  } catch {
    return null;
  }
}
