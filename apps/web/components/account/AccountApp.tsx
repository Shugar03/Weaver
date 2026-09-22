"use client";

// /account — el panel del consumidor (ADR-0007). Layout: rail izquierda con
// tabs (Overview / Keys / Billing / Docs) — modelo mental OpenRouter (Jakob).
// El balance va primero y grande: es el 20% que da el 80% del valor (Pareto).
// Estados: loading skeleton con forma final, errores inline, empty states
// que enseñan (Doherty / Paradox of the Active User).
import { useCallback, useEffect, useState } from "react";
import { Gauge, Key, Receipt, BookOpen, SignOut } from "@phosphor-icons/react";
import {
  accountToken,
  clearAccountToken,
  getMe,
  type MeInfo,
} from "../../lib/account";
import { LoginPanel } from "./LoginPanel";
import { OverviewTab } from "./OverviewTab";
import { KeysTab } from "./KeysTab";
import { BillingTab } from "./BillingTab";
import { DocsTab } from "./DocsTab";

type Tab = "overview" | "keys" | "billing" | "docs";
const TABS: { id: Tab; label: string; icon: typeof Gauge }[] = [
  { id: "overview", label: "OVERVIEW", icon: Gauge },
  { id: "keys", label: "API KEYS", icon: Key },
  { id: "billing", label: "BILLING", icon: Receipt },
  { id: "docs", label: "INTEGRATE", icon: BookOpen },
];

export function AccountApp({ base }: { base: string }) {
  const [token, setToken] = useState<string | null>(null);
  const [me, setMe] = useState<MeInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("overview");

  const refresh = useCallback(async (t: string) => {
    try {
      setMe(await getMe(base, t));
      setErr(null);
    } catch (e) {
      if (e instanceof Error && "status" in e && (e as { status: number }).status === 401) {
        clearAccountToken();
        setToken(null);
        setMe(null);
      }
      setErr(e instanceof Error ? e.message : "error");
    } finally {
      setLoading(false);
    }
  }, [base]);

  useEffect(() => {
    const t = accountToken();
    if (t) {
      setToken(t);
      void refresh(t);
      const id = setInterval(() => void refresh(t), 15_000);
      return () => clearInterval(id);
    }
    setLoading(false);
  }, [refresh]);

  function login(t: string) {
    setToken(t);
    setLoading(true);
    void refresh(t);
  }

  function logout() {
    clearAccountToken();
    setToken(null);
    setMe(null);
  }

  if (!token) {
    return (
      <main className="mx-auto max-w-7xl px-4 pb-16 md:px-6">
        <section className="pt-14 pb-10 text-center">
          <div className="font-tech text-lg tracking-[0.2em] text-fog">
            <span className="text-lima">{"//"}</span> ACCOUNT
          </div>
          <h1 className="mt-4 text-4xl leading-[1.02] font-bold tracking-tight md:text-5xl">
            Your keys, your credits<span className="text-lima">.</span>
          </h1>
          <p className="mx-auto mt-4 max-w-[58ch] text-sm leading-relaxed text-fog">
            Una API key <span className="font-tech text-base text-white">wvr_…</span> para usar Weaver en
            opencode, pi, hermes o cualquier cliente OpenAI. Créditos prepagos en USDC, debit medido por token.
          </p>
        </section>
        <LoginPanel base={base} onLogin={login} />
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-7xl px-4 pb-16 md:px-6">
      <div className="flex flex-col gap-6 pt-8 md:flex-row">
        {/* rail: tabs + identidad */}
        <aside className="w-full shrink-0 md:w-56">
          <div className="border border-line bg-panel p-4">
            <div className="font-tech text-sm tracking-[0.2em] text-fog">ACCOUNT</div>
            {loading && !me ? (
              <div className="mt-2 h-6 animate-pulse bg-line" />
            ) : (
              <div className="mt-1 truncate font-tech text-base text-white" title={me?.accountId}>
                {me?.accountId ?? "…"}
              </div>
            )}
            {me?.walletPubkey && (
              <div className="mt-1 truncate font-tech text-sm text-fog" title={me.walletPubkey}>
                {me.walletPubkey.slice(0, 8)}…{me.walletPubkey.slice(-6)}
              </div>
            )}
          </div>
          <nav className="mt-3 flex gap-1 overflow-x-auto border border-line bg-panel p-1 md:flex-col">
            {TABS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`flex items-center gap-2 px-3 py-2.5 font-tech text-base tracking-[0.15em] whitespace-nowrap transition-colors ${
                  tab === id ? "bg-lima text-black" : "text-fog hover:text-white"
                }`}
              >
                <Icon size={18} weight={tab === id ? "bold" : "regular"} />
                {label}
              </button>
            ))}
            <button
              onClick={logout}
              className="flex items-center gap-2 px-3 py-2.5 font-tech text-base tracking-[0.15em] text-fog transition-colors hover:text-danger md:mt-2 md:border-t md:border-line"
            >
              <SignOut size={18} />
              SALIR
            </button>
          </nav>
        </aside>

        <section className="min-w-0 flex-1">
          {err && (
            <div className="mb-4 border border-danger/60 bg-danger/10 px-4 py-2 font-tech text-base text-danger">
              {err}
            </div>
          )}
          {tab === "overview" && <OverviewTab me={me} loading={loading} onRefresh={() => void refresh(token)} onGoKeys={() => setTab("keys")} />}
          {tab === "keys" && <KeysTab base={base} token={token} />}
          {tab === "billing" && <BillingTab base={base} token={token} me={me} />}
          {tab === "docs" && <DocsTab base={base} token={token} />}
        </section>
      </div>
    </main>
  );
}
