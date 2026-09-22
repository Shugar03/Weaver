// Server-only: lee el deployment commiteado del contrato (fs).
// Importar solo desde Server Components — jamás desde "use client".
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Deployment } from "./site";

export async function readDeployment(): Promise<Deployment | null> {
  try {
    const p = join(process.cwd(), "..", "..", "contracts", "weaver-escrow", "deployments", "testnet.json");
    return JSON.parse(await readFile(p, "utf8")) as Deployment;
  } catch {
    return null;
  }
}
