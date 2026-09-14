import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const EXPLORER = {
  tx: "https://stellar.expert/explorer/testnet/tx/",
  contract: "https://stellar.expert/explorer/testnet/contract/",
  account: "https://stellar.expert/explorer/testnet/account/",
} as const;

export type Deployment = {
  contract_id: string;
  admin: string;
  worker?: string;
  token_usdc_sac: string;
  txs: Record<string, string>;
};

export async function readDeployment(): Promise<Deployment | null> {
  try {
    const p = join(process.cwd(), "..", "..", "contracts", "weaver-escrow", "deployments", "testnet.json");
    return JSON.parse(await readFile(p, "utf8")) as Deployment;
  } catch {
    return null;
  }
}

export function short(h: string) {
  return h.length > 12 ? `${h.slice(0, 4)}...${h.slice(-4)}` : h;
}
