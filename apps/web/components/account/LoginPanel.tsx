"use client";

// Login del panel — tres caminos, uno solo obligatorio:
// 1. CREATE ACCOUNT: un click → mgmt token (una vez) + memo de depósito.
// 2. Paste token: wvr_acct_ / wvr_sess_ pegado (Postel: normaliza whitespace).
// 3. Wallet: challenge → firma manual → sesión (v1 sin Freighter — ADR-0007).
import { useState } from "react";
import { Key, Wallet, Lightning, Copy, Check } from "@phosphor-icons/react";
import { createAccount, saveAccountToken, walletChallenge, walletSession } from "../../lib/account";

export function LoginPanel({ base, onLogin }: { base: string; onLogin: (token: string) => void }) {
  const [mode, setMode] = useState<"pick" | "token" | "wallet">("pick");
  const [created, setCreated] = useState<{ accountId: string; mgmtToken: string; depositMemo: string } | null>(null);
  const [token, setToken] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  // wallet flow
  const [challenge, setChallenge] = useState<{ nonce: string; expiresAt: number } | null>(null);
  const [pubkey, setPubkey] = useState("");
  const [sig, setSig] = useState("");

  async function mk() {
    setBusy(true);
    setErr(null);
    try {
      const a = await createAccount(base);
      setCreated(a);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "error");
    } finally {
      setBusy(false);
    }
  }

  function pasteLogin() {
    const t = token.trim();
    if (!t.startsWith("wvr_acct_") && !t.startsWith("wvr_sess_")) {
      setErr("el token debe empezar con wvr_acct_ o wvr_sess_");
      return;
    }
    saveAccountToken(t);
    onLogin(t);
  }

  async function walletLogin() {
    setBusy(true);
    setErr(null);
    try {
      const ch = challenge ?? (await walletChallenge(base));
      setChallenge(ch);
      if (!pubkey.trim().startsWith("G") || !sig.trim()) {
        setErr("pegá tu pubkey G… y la firma hex del nonce (stellar keys sign / wallet)");
        return;
      }
      const s = await walletSession(base, pubkey.trim(), ch.nonce, sig.trim());
      saveAccountToken(s.sessionToken);
      onLogin(s.sessionToken);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "error de login");
      setChallenge(null); // nonce consumido o expirado → pedir otro
    } finally {
      setBusy(false);
    }
  }

  // Cuenta recién creada: el secreto se muestra UNA vez — esta pantalla es
  // el único lugar donde existe en claro. Guardar = copiar + entrar.
  if (created) {
    return (
      <div className="mx-auto max-w-xl border border-lima/60 bg-panel p-6">
        <div className="font-tech text-lg tracking-[0.2em] text-lima">CUENTA CREADA — GUARDÁ TU TOKEN</div>
        <p className="mt-2 text-sm leading-relaxed text-fog">
          Es la <span className="text-white">única vez</span> que se muestra. Es tu login: quien lo tenga,
          maneja la cuenta. Sin recuperación.
        </p>
        <div className="mt-4 flex items-center gap-2 border border-line bg-void px-3 py-2">
          <code className="flex-1 overflow-x-auto font-tech text-base whitespace-nowrap text-lima">{created.mgmtToken}</code>
          <button
            onClick={() => {
              void navigator.clipboard.writeText(created.mgmtToken).then(() => setCopied(true));
            }}
            className="text-fog transition-colors hover:text-lima"
            title="copiar"
          >
            {copied ? <Check size={18} /> : <Copy size={18} />}
          </button>
        </div>
        <div className="mt-3 font-tech text-base text-fog">
          deposit memo: <span className="text-white">{created.depositMemo}</span>
        </div>
        <button
          onClick={() => {
            saveAccountToken(created.mgmtToken);
            onLogin(created.mgmtToken);
          }}
          className="mt-5 w-full bg-lima px-4 py-3 font-tech text-lg tracking-[0.15em] text-black transition-colors hover:bg-white"
        >
          YA LO GUARDÉ — ENTRAR
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl">
      {mode === "pick" && (
        <div className="space-y-3">
          <button
            onClick={() => void mk()}
            disabled={busy}
            className="flex w-full items-center gap-4 border border-lima/60 bg-panel p-5 text-left transition-colors hover:border-lima disabled:opacity-50"
          >
            <Lightning size={28} className="shrink-0 text-lima" />
            <span>
              <span className="block font-tech text-xl tracking-[0.1em] text-white">CREAR CUENTA</span>
              <span className="block text-sm text-fog">un click, sin email ni password — te llevas un token</span>
            </span>
          </button>
          <button
            onClick={() => setMode("token")}
            className="flex w-full items-center gap-4 border border-line bg-panel p-5 text-left transition-colors hover:border-fog"
          >
            <Key size={28} className="shrink-0 text-fog" />
            <span>
              <span className="block font-tech text-xl tracking-[0.1em] text-white">TENGO UN TOKEN</span>
              <span className="block text-sm text-fog">wvr_acct_… o wvr_sess_…</span>
            </span>
          </button>
          <button
            onClick={() => {
              setMode("wallet");
              void walletChallenge(base).then(setChallenge).catch(() => setErr("gateway sin respuesta"));
            }}
            className="flex w-full items-center gap-4 border border-line bg-panel p-5 text-left transition-colors hover:border-fog"
          >
            <Wallet size={28} className="shrink-0 text-fog" />
            <span>
              <span className="block font-tech text-xl tracking-[0.1em] text-white">WALLET STELLAR</span>
              <span className="block text-sm text-fog">firmás un nonce, tu pubkey es tu cuenta</span>
            </span>
          </button>
          {err && <div className="border border-danger/60 px-3 py-2 font-tech text-base text-danger">{err}</div>}
        </div>
      )}

      {mode === "token" && (
        <div className="border border-line bg-panel p-6">
          <div className="font-tech text-lg tracking-[0.2em] text-fog">PEGÁ TU TOKEN</div>
          <input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="wvr_acct_… o wvr_sess_…"
            spellCheck={false}
            autoComplete="off"
            className="mt-4 w-full border border-line bg-void px-3 py-3 font-tech text-lg text-white outline-none placeholder:text-fog/50 focus:border-lima"
          />
          {err && <div className="mt-2 font-tech text-base text-danger">{err}</div>}
          <div className="mt-4 flex gap-3">
            <button
              onClick={pasteLogin}
              className="flex-1 bg-lima px-4 py-3 font-tech text-lg tracking-[0.15em] text-black hover:bg-white"
            >
              ENTRAR
            </button>
            <button onClick={() => setMode("pick")} className="border border-line px-4 py-3 font-tech text-lg text-fog hover:text-white">
              VOLVER
            </button>
          </div>
        </div>
      )}

      {mode === "wallet" && (
        <div className="border border-line bg-panel p-6">
          <div className="font-tech text-lg tracking-[0.2em] text-fog">LOGIN POR WALLET</div>
          <p className="mt-2 text-sm leading-relaxed text-fog">
            Firmá este nonce con tu wallet (<span className="font-tech text-base text-white">stellar keys sign</span>,
            Freighter, o cualquier signer ed25519):
          </p>
          <div className="mt-3 flex items-center gap-2 border border-line bg-void px-3 py-2">
            <code className="flex-1 overflow-x-auto font-tech text-base whitespace-nowrap text-lima">
              weaver-login:{challenge?.nonce ?? "…"}
            </code>
            <button
              onClick={() => challenge && void navigator.clipboard.writeText(`weaver-login:${challenge.nonce}`)}
              className="text-fog hover:text-lima"
              title="copiar mensaje a firmar"
            >
              <Copy size={18} />
            </button>
          </div>
          <input
            value={pubkey}
            onChange={(e) => setPubkey(e.target.value)}
            placeholder="pubkey G…"
            spellCheck={false}
            className="mt-3 w-full border border-line bg-void px-3 py-3 font-tech text-lg text-white outline-none placeholder:text-fog/50 focus:border-lima"
          />
          <input
            value={sig}
            onChange={(e) => setSig(e.target.value)}
            placeholder="firma (hex)"
            spellCheck={false}
            className="mt-3 w-full border border-line bg-void px-3 py-3 font-tech text-lg text-white outline-none placeholder:text-fog/50 focus:border-lima"
          />
          {err && <div className="mt-2 font-tech text-base text-danger">{err}</div>}
          <div className="mt-4 flex gap-3">
            <button
              onClick={() => void walletLogin()}
              disabled={busy}
              className="flex-1 bg-lima px-4 py-3 font-tech text-lg tracking-[0.15em] text-black hover:bg-white disabled:opacity-50"
            >
              {busy ? "VERIFICANDO…" : "ENTRAR"}
            </button>
            <button onClick={() => setMode("pick")} className="border border-line px-4 py-3 font-tech text-lg text-fog hover:text-white">
              VOLVER
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
