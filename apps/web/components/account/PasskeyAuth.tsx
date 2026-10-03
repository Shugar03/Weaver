"use client";

import { useState } from "react";
import { Key, ShieldCheck, Lightning, Check } from "@phosphor-icons/react";
import {
  isPasskeySupported,
  loginWithPasskey,
  USER_ROLE_INDEX,
  AGENT_ROLE_INDEX,
  OPERATOR_ROLE_INDEX,
  type DerivedWallet,
} from "../../lib/passkey";

interface PasskeyAuthProps {
  base: string;
  onLogin: (token: string) => void;
}

export function PasskeyAuth({ base, onLogin }: PasskeyAuthProps) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [roleIndex, setRoleIndex] = useState<number>(USER_ROLE_INDEX);
  const [derivedAccount, setDerivedAccount] = useState<DerivedWallet | null>(null);

  async function handlePasskeyLogin() {
    setBusy(true);
    setErr(null);
    try {
      if (!isPasskeySupported()) {
        throw new Error(
          "Tu navegador no soporta Passkeys o WebAuthn PRF. Podés ingresar con Management Token o Wallet tradicional."
        );
      }
      const result = await loginWithPasskey(base, { accountIndex: roleIndex });
      setDerivedAccount(result.wallet);
      onLogin(result.sessionToken);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error durante autenticación con Passkey");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border border-purple-500/40 bg-panel p-5 transition-colors hover:border-purple-500/70">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <Key size={26} className="text-purple-400 shrink-0" />
          <div>
            <div className="flex items-center gap-2">
              <span className="font-tech text-xl tracking-[0.1em] text-white">
                PASSKEY MONAD (MERA)
              </span>
              <span className="rounded bg-purple-900/60 px-2 py-0.5 font-tech text-xs text-purple-300 border border-purple-700/50">
                PRF EOA
              </span>
            </div>
            <p className="mt-1 text-sm text-fog">
              Face ID / Touch ID sin seed phrases. Deriva tu Monad EOA determinista al instante.
            </p>
          </div>
        </div>
      </div>

      {/* Selector de sub-identidades: Tesis "One Passkey, Many Keys" */}
      <div className="mt-4 border-t border-line/60 pt-3">
        <div className="flex items-center justify-between text-xs font-tech text-fog mb-2">
          <span>ONE PASSKEY, MANY KEYS (ROL MONAD):</span>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <button
            type="button"
            onClick={() => setRoleIndex(USER_ROLE_INDEX)}
            className={`border px-2 py-1.5 text-left font-tech text-xs transition-colors ${
              roleIndex === USER_ROLE_INDEX
                ? "border-purple-400 bg-purple-950/40 text-purple-200"
                : "border-line bg-void text-fog hover:text-white"
            }`}
          >
            <div className="font-bold">USER (0)</div>
            <div className="text-[10px] opacity-75">Depósitos / Main</div>
          </button>
          <button
            type="button"
            onClick={() => setRoleIndex(AGENT_ROLE_INDEX)}
            className={`border px-2 py-1.5 text-left font-tech text-xs transition-colors ${
              roleIndex === AGENT_ROLE_INDEX
                ? "border-purple-400 bg-purple-950/40 text-purple-200"
                : "border-line bg-void text-fog hover:text-white"
            }`}
          >
            <div className="font-bold">AGENT (1)</div>
            <div className="text-[10px] opacity-75">Inferencia Autónoma</div>
          </button>
          <button
            type="button"
            onClick={() => setRoleIndex(OPERATOR_ROLE_INDEX)}
            className={`border px-2 py-1.5 text-left font-tech text-xs transition-colors ${
              roleIndex === OPERATOR_ROLE_INDEX
                ? "border-purple-400 bg-purple-950/40 text-purple-200"
                : "border-line bg-void text-fog hover:text-white"
            }`}
          >
            <div className="font-bold">OPERATOR (2)</div>
            <div className="text-[10px] opacity-75">Staking / Forges</div>
          </button>
        </div>
      </div>

      <button
        onClick={() => void handlePasskeyLogin()}
        disabled={busy}
        className="mt-4 flex w-full items-center justify-center gap-2 bg-purple-600 px-4 py-3 font-tech text-base tracking-[0.15em] text-white transition-colors hover:bg-purple-500 disabled:opacity-50"
      >
        <Lightning size={18} />
        {busy ? "AUTENTICANDO BIOMETRÍA…" : "INGRESAR CON PASSKEY / TOUCH ID"}
      </button>

      {derivedAccount && (
        <div className="mt-3 flex items-center gap-2 border border-purple-500/40 bg-void px-3 py-2 text-xs font-tech text-purple-300">
          <Check size={16} className="text-purple-400 shrink-0" />
          <span className="truncate">EOA Monad: {derivedAccount.address}</span>
        </div>
      )}

      {err && (
        <div className="mt-3 border border-danger/60 px-3 py-2 font-tech text-xs text-danger">
          {err}
        </div>
      )}
    </div>
  );
}
