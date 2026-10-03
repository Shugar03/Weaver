// S33 — identidad del forge: keypair en forge.json (0600).
// El secreto NUNCA sale del archivo ni viaja por la red — solo firma local.
// chain: "stellar" (ed25519, pubkey G…/secret S…) o "evm" (secp256k1,
// pubkey 0x address / secret 0x privkey) — Monad ADR-0008.
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

export type InstanceCfg = {
  instanceId: string;
  model: string;
  capability: "text" | "image";
  maxConcurrent: number;
  loadTimeMs: number;
  vramGb?: number; // footprint estimado — init lo llena desde /api/tags size
};

export type ForgeChain = "stellar" | "evm";

export type ForgeConfig = {
  pubkey: string;
  secret: string; // identidad = payout address = este pubkey (S… u 0x…)
  chain?: ForgeChain; // ausente = "stellar" (configs viejas)
  gateway: string; // base http del gateway, ej http://127.0.0.1:3001
  instances: InstanceCfg[];
  // Budgets del operador (ADR-0005, Fase 7): el daemon los respeta local.
  budgets?: { maxVramGb?: number; idleOnly?: boolean };
};

// init: genera keypair nueva. Re-inicializar PISA la identidad — el payout
// acumulado queda en la pubkey vieja (se advierte en cli).
export function initConfig(
  path: string,
  opts: { gateway: string; instances: InstanceCfg[]; budgets?: ForgeConfig["budgets"]; chain?: ForgeChain },
): ForgeConfig {
  const chain = opts.chain ?? "stellar";
  // EVM: identidad = address del secp256k1 (el mismo key firma proofs y cobra).
  // Stellar: keypair ed25519 clásico.
  const { pubkey, secret } =
    chain === "evm"
      ? (() => {
          const pk = generatePrivateKey();
          return { pubkey: privateKeyToAccount(pk).address, secret: pk };
        })()
      : (() => {
          const kp = Keypair.random();
          return { pubkey: kp.publicKey(), secret: kp.secret() };
        })();
  const cfg: ForgeConfig = {
    pubkey,
    secret,
    chain,
    gateway: opts.gateway,
    instances: opts.instances,
    ...(opts.budgets ? { budgets: opts.budgets } : {}),
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2));
  chmodSync(path, 0o600); // el secreto es solo del operador
  return cfg;
}

export function loadConfig(path: string): ForgeConfig {
  if (!existsSync(path)) throw new Error(`sin config en ${path} — corré \`weaver-forge init\` primero`);
  const cfg = JSON.parse(readFileSync(path, "utf8")) as ForgeConfig;
  if (!cfg.secret || !cfg.pubkey || !Array.isArray(cfg.instances)) {
    throw new Error(`forge.json inválido en ${path}`);
  }
  return cfg;
}
