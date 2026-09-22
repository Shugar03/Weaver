// Constantes y tipos puros — safe para client components (nada de fs acá).
// Lo que lee disco vive en lib/deployment.ts (server-only).
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

export function short(h: string) {
  return h.length > 12 ? `${h.slice(0, 4)}...${h.slice(-4)}` : h;
}
