// Constantes y tipos puros — safe para client components (nada de fs acá).
// Lo que lee disco vive en lib/deployment.ts (server-only).
export const EXPLORERS = {
  stellar: {
    tx: "https://stellar.expert/explorer/testnet/tx/",
    contract: "https://stellar.expert/explorer/testnet/contract/",
    account: "https://stellar.expert/explorer/testnet/account/",
    name: "Stellar · Soroban · Testnet",
  },
  evm: {
    tx: "https://testnet.monadvision.com/tx/",
    contract: "https://testnet.monadvision.com/address/",
    account: "https://testnet.monadvision.com/address/",
    name: "Monad · EVM · Testnet",
  },
} as const;

export type Chain = keyof typeof EXPLORERS;
// Back-compat: callers que aún no migraron a txUrl/accountUrl.
export const EXPLORER = EXPLORERS.stellar;

export type Deployment = {
  chain?: Chain;
  contract_id: string;
  admin: string;
  worker?: string;
  token_usdc_sac?: string;
  token_usdc?: string;
  credits_contract?: string;
  txs: Record<string, string>;
};

// Los hashes determinan la chain: todo lo EVM va prefijado 0x, Stellar jamás.
export function chainOf(id: string, fallback: Chain = "stellar"): Chain {
  return id.startsWith("0x") ? "evm" : id.length > 0 ? "stellar" : fallback;
}

export function txUrl(hash: string, chain?: Chain) {
  return `${EXPLORERS[chain ?? chainOf(hash)].tx}${hash}`;
}

export function accountUrl(addr: string, chain?: Chain) {
  return `${EXPLORERS[chain ?? chainOf(addr)].account}${addr}`;
}

export function contractUrl(addr: string, chain?: Chain) {
  return `${EXPLORERS[chain ?? chainOf(addr)].contract}${addr}`;
}

export function short(h: string) {
  return h.length > 12 ? `${h.slice(0, 4)}...${h.slice(-4)}` : h;
}
