"use client";

// Overview — balance primero y grande (Pareto/Selective Attention), usage
// medido, y checklist de activación cuando falta algo (Zeigarnik: lo
// incompleto se señaliza, no se esconde). Depósito: memo + address copyable.
import { useState } from "react";
import { Check, Copy, ArrowDown } from "@phosphor-icons/react";
import type { MeInfo } from "../../lib/account";

function Copyable({ value, label }: { value: string; label?: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      onClick={() => void navigator.clipboard.writeText(value).then(() => { setOk(true); setTimeout(() => setOk(false), 1200); })}
      className="flex items-center gap-2 font-tech text-base text-lima hover:text-white"
      title={`copiar ${label ?? value}`}
    >
      {ok ? <Check size={15} /> : <Copy size={15} />}
      {label ?? value}
    </button>
  );
}

export function OverviewTab({
  me,
  loading,
  onRefresh,
  onGoKeys,
}: {
  me: MeInfo | null;
  loading: boolean;
  onRefresh: () => void;
  onGoKeys: () => void;
}) {
  if (loading && !me) {
    return (
      <div className="space-y-4">
        <div className="h-28 animate-pulse border border-line bg-panel" />
        <div className="h-40 animate-pulse border border-line bg-panel" />
      </div>
    );
  }
  if (!me) return <div className="border border-line bg-panel p-6 font-tech text-lg text-fog">sin datos — gateway caído o token inválido</div>;

  const noCredits = me.balanceUSDC <= 0;
  const depositAddress = me.depositAddress;

  return (
    <div className="space-y-4">
      {/* Balance — el número que importa */}
      <div className="border border-line bg-panel p-6">
        <div className="font-tech text-sm tracking-[0.2em] text-fog">BALANCE</div>
        <div className={`mt-2 font-tech text-6xl leading-none tracking-tight ${noCredits ? "text-danger" : "text-lima"}`}>
          ${me.balanceUSDC.toFixed(4)}
          <span className="ml-2 text-2xl text-fog">USDC</span>
        </div>
        <div className="mt-2 font-tech text-sm text-fog">{me.balanceStroops} stroops</div>
      </div>

      {/* Checklist de activación — Zeigarnik: señalizar lo incompleto */}
      {noCredits && (
        <div className="border border-lima/50 bg-panel p-5">
          <div className="font-tech text-base tracking-[0.2em] text-lima">ACTIVÁ TU CUENTA</div>
          <ol className="mt-3 space-y-2 font-tech text-base text-fog">
            <li className="flex gap-2">
              <span className="text-lima">1.</span>
              <span>Fondeá: USDC a la deposit address con <span className="text-white">memo = {me.depositMemo}</span></span>
            </li>
            <li className="flex gap-2">
              <span className="text-lima">2.</span>
              <span>Creá una API key en <button onClick={onGoKeys} className="text-white underline hover:text-lima">API KEYS</button></span>
            </li>
            <li className="flex gap-2">
              <span className="text-lima">3.</span>
              <span>Conectá tu cliente en <span className="text-white">INTEGRATE</span> o usá el chat</span>
            </li>
          </ol>
        </div>
      )}

      {/* Depósito — instrucciones siempre visibles */}
      <div className="border border-line bg-panel p-5">
        <div className="flex items-center gap-2 font-tech text-base tracking-[0.2em] text-fog">
          <ArrowDown size={16} className="text-lima" /> FONDEAR (USDC · STELLAR TESTNET)
        </div>
        <p className="mt-2 text-sm leading-relaxed text-fog">
          Enviá USDC a la deposit address con <span className="text-white">memo text</span> igual a tu memo.
          El watcher acredita automáticamente (~1 min). Sin memo o memo trucho = fondos sin acreditar.
        </p>
        <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
          <div className="border border-line bg-void p-3">
            <div className="font-tech text-xs tracking-[0.2em] text-fog">DEPOSIT ADDRESS</div>
            <div className="mt-1">
              {depositAddress ? (
                <Copyable value={depositAddress} label={`${depositAddress.slice(0, 12)}…${depositAddress.slice(-8)}`} />
              ) : (
                <span className="font-tech text-base text-danger">no configurada (DEPOSIT_ADDRESS en el gateway)</span>
              )}
            </div>
          </div>
          <div className="border border-line bg-void p-3">
            <div className="font-tech text-xs tracking-[0.2em] text-fog">TU MEMO</div>
            <div className="mt-1"><Copyable value={me.depositMemo} /></div>
          </div>
        </div>
      </div>

      {/* Usage — medido, agregado sobre las keys de la cuenta */}
      <div className="grid grid-cols-3 gap-px border border-line bg-line">
        {[
          ["JOBS", String(me.usage.jobs)],
          ["OK", `${(me.usage.okRate * 100).toFixed(1)}%`],
          ["CUENTA", me.accountId.slice(0, 12) + "…"],
        ].map(([k, v]) => (
          <div key={k} className="bg-panel p-4 text-center">
            <div className="font-tech text-xs tracking-[0.2em] text-fog">{k}</div>
            <div className="mt-1 font-tech text-2xl text-white">{v}</div>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between font-tech text-sm text-fog">
        <span>* uso medido por telemetría del gateway, agregado sobre tus keys.</span>
        <button onClick={onRefresh} className="text-fog underline hover:text-lima">refrescar</button>
      </div>
    </div>
  );
}
