// Monad Mera Passkeys — "One Passkey, Many Keys" (WebAuthn PRF → Monad EOA)
// SDK oficial @category-labs/mera para la ceremonia WebAuthn PRF + derivación
// BIP-44 canónica (m/44'/60'/0'/0/index): la misma que documenta mera —
// la passkey produce un mnemonic exportable que importa idéntico en
// MetaMask/Rabby. Un biométrico → N EOAs aisladas por índice (roles).
import {
  createPasskeyWithPrfOutput,
  getPasskeyPrfOutput,
  isMeraError,
  type PasskeyCredentialMetadata,
} from "@category-labs/mera";
import { HDKey } from "@scure/bip32";
import { entropyToMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { type Address, type Hex, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { walletChallenge, walletSession, saveAccountToken } from "./account.ts";

export type { Address, Hex };

export const USER_ROLE_INDEX = 0;
export const AGENT_ROLE_INDEX = 1;
export const OPERATOR_ROLE_INDEX = 2;

const CREDENTIAL_KEY = "weaver.passkey.credential";

export interface DerivedWallet {
  index: number;
  role: "user" | "agent" | "operator" | "custom";
  address: Address;
  privateKey: Hex;
  signMessage(message: string | Uint8Array): Promise<Hex>;
}

export interface MeraWallets {
  user: DerivedWallet;
  agent: DerivedWallet;
  operator: DerivedWallet;
}

/**
 * Deriva una EOA secp256k1 de Monad por índice BIP-44 a partir del prfOutput
 * de la passkey (32B de entropía → mnemonic → seed → m/44'/60'/0'/0/index).
 * Es la derivación canónica de mera: exportar el mnemonic reproduce las
 * mismas cuentas en cualquier wallet HD — portabilidad real, no custodia.
 */
export function deriveMonadWallet(prfOutput: Uint8Array, keyIndex = 0): DerivedWallet {
  if (prfOutput.length < 32) {
    throw new Error("El prfOutput debe tener al menos 32 bytes de entropía");
  }
  const seed = mnemonicToSeedSync(entropyToMnemonic(prfOutput.slice(0, 32), wordlist));
  const node = HDKey.fromMasterSeed(seed).derive(`m/44'/60'/0'/0/${keyIndex}`);
  if (node.privateKey === null) throw new Error("derivación BIP-44 sin clave");
  const privateKey = toHex(node.privateKey);
  const account = privateKeyToAccount(privateKey);

  const role: DerivedWallet["role"] =
    keyIndex === USER_ROLE_INDEX
      ? "user"
      : keyIndex === AGENT_ROLE_INDEX
        ? "agent"
        : keyIndex === OPERATOR_ROLE_INDEX
          ? "operator"
          : "custom";

  return {
    index: keyIndex,
    role,
    address: account.address,
    privateKey,
    signMessage: async (message: string | Uint8Array) => {
      const msg = typeof message === "string" ? message : { raw: message };
      return await account.signMessage({ message: msg });
    },
  };
}

/**
 * Las tres EOAs estándar del ecosistema Weaver de una sola passkey:
 * - user: depósitos y balance (índice 0)
 * - agent: delegación autónoma de ejecuciones (índice 1)
 * - operator: gestión de forges (índice 2)
 */
export function deriveMultipleRoleWallets(prfOutput: Uint8Array): MeraWallets {
  return {
    user: deriveMonadWallet(prfOutput, USER_ROLE_INDEX),
    agent: deriveMonadWallet(prfOutput, AGENT_ROLE_INDEX),
    operator: deriveMonadWallet(prfOutput, OPERATOR_ROLE_INDEX),
  };
}

export function isPasskeySupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.PublicKeyCredential !== "undefined" &&
    typeof navigator.credentials !== "undefined"
  );
}

const storedCredential = (): PasskeyCredentialMetadata | undefined => {
  try {
    const raw = localStorage.getItem(CREDENTIAL_KEY);
    return raw ? (JSON.parse(raw) as PasskeyCredentialMetadata) : undefined;
  } catch {
    return undefined;
  }
};

const saveCredential = (m: PasskeyCredentialMetadata) => {
  try {
    localStorage.setItem(CREDENTIAL_KEY, JSON.stringify(m));
  } catch {}
};

/**
 * prfOutput de la passkey vía SDK oficial mera:
 * - con credencial guardada → get (sign-in directo a ESA passkey)
 * - sin credencial → create (onboarding; cada create genera passkey nueva)
 * - credencial stale → re-create y se re-guarda la metadata nueva
 */
export async function getMeraPrfOutput(): Promise<Uint8Array> {
  const rpId = typeof location !== "undefined" ? location.hostname : "localhost";
  const stored = storedCredential();
  if (stored) {
    try {
      const { prfOutput, credentialId } = await getPasskeyPrfOutput({ rpId, credential: stored });
      saveCredential({ credentialId });
      return prfOutput;
    } catch (e) {
      if (!(isMeraError(e) && e.code === "PASSKEY_OPERATION_FAILED")) throw e;
    }
  }
  const created = await createPasskeyWithPrfOutput({
    rp: { id: rpId, name: "Weaver" },
    user: { name: "weaver-user", displayName: "Weaver User" },
  });
  saveCredential({ credentialId: created.credentialId, transports: created.transports });
  return created.prfOutput;
}

/**
 * Login completo con Passkey a Weaver Gateway:
 * 1. challenge al gateway (/v1/me/challenge)
 * 2. prfOutput vía mera (get o create según haya passkey)
 * 3. deriva EOAs BIP-44 (roles user/agent/operator)
 * 4. personal_sign 'weaver-login:<nonce>' — dualVerify ecrecover en gateway
 * 5. sesión en /v1/me/session + token a storage
 */
export async function loginWithPasskey(
  gatewayBase: string,
  options?: { accountIndex?: number; prfSeedOverride?: Uint8Array }
): Promise<{
  sessionToken: string;
  accountId: string;
  expiresAt: number;
  wallet: DerivedWallet;
  roles: MeraWallets;
}> {
  const ch = await walletChallenge(gatewayBase);
  const prfOutput = options?.prfSeedOverride ?? (await getMeraPrfOutput());
  const roles = deriveMultipleRoleWallets(prfOutput);
  const targetWallet =
    options?.accountIndex !== undefined
      ? deriveMonadWallet(prfOutput, options.accountIndex)
      : roles.user;

  const sigHex = await targetWallet.signMessage(`weaver-login:${ch.nonce}`);
  const cleanSig = sigHex.startsWith("0x") ? sigHex.slice(2) : sigHex;

  const session = await walletSession(
    gatewayBase,
    targetWallet.address,
    ch.nonce,
    cleanSig
  );

  saveAccountToken(session.sessionToken);

  return {
    ...session,
    wallet: targetWallet,
    roles,
  };
}
