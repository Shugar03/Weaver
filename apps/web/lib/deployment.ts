// Server-only: lee el deployment commiteado del contrato (fs).
// Importar solo desde Server Components — jamás desde "use client".
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Deployment } from "./site";

export async function readDeployment(): Promise<Deployment | null> {
  // Monad es la chain activa (Metropolis); Stellar queda como fallback histórico.
  const candidates: [string, Deployment["chain"]][] = [
    ["weaver-escrow-evm", "evm"],
    ["weaver-escrow", "stellar"],
  ];
  for (const [dir, chain] of candidates) {
    try {
      const p = join(process.cwd(), "..", "..", "contracts", dir, "deployments", "testnet.json");
      const d = JSON.parse(await readFile(p, "utf8")) as Deployment;
      return { ...d, chain: d.chain ?? chain };
    } catch { /* siguiente candidato */ }
  }
  return null;
}
