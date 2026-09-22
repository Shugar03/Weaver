"use client";

// Billing — ledger append-only visible: topups (depósitos on-chain) y debits
// (consumo medido post-serve). Cada evento muestra ref: dep:opId linkea a
// stellar.expert; job:… es la ejecución que consumió. Nada se inventa.
import { useCallback, useEffect, useState } from "react";
import { ArrowDown, ArrowUp } from "@phosphor-icons/react";
import { getBilling, type LedgerEvent, type MeInfo } from "../../lib/account";

export function BillingTab({ base, token, me }: { base: string; token: string; me: MeInfo | null }) {
  const [events, setEvents] = useState<LedgerEvent[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const b = await getBilling(base, token);
      setEvents(b.events.slice().reverse()); // API devuelve asc; mostrar reciente primero
    } catch (e) {
      setErr(e instanceof Error ? e.message : "error");
    }
  }, [base, token]);

  useEffect(() => {
    void reload();
    const id = setInterval(() => void reload(), 20_000);
    return () => clearInterval(id);
  }, [reload]);

  return (
    <div className="space-y-4">
      <div className="border border-line bg-panel p-5">
        <div className="font-tech text-sm tracking-[0.2em] text-fog">BALANCE ACTUAL</div>
        <div className={`mt-1 font-tech text-4xl ${me && me.balanceUSDC > 0 ? "text-lima" : "text-danger"}`}>
          ${(me?.balanceUSDC ?? 0).toFixed(4)} <span className="text-xl text-fog">USDC</span>
        </div>
      </div>

      {err && <div className="border border-danger/60 px-3 py-2 font-tech text-base text-danger">{err}</div>}

      {events === null ? (
        <div className="h-40 animate-pulse border border-line bg-panel" />
      ) : events.length === 0 ? (
        <div className="border border-line bg-panel p-8 text-center">
          <div className="font-tech text-xl text-fog">ledger vacío</div>
          <p className="mx-auto mt-2 max-w-[46ch] text-sm text-fog">
            Acá aparecen tus depósitos (topup) y cada job cobrado (debit) con su referencia.
          </p>
        </div>
      ) : (
        <div className="border border-line bg-panel">
          <div className="grid grid-cols-[auto_auto_1fr_auto] items-center gap-x-4 border-b border-line px-4 py-2 font-tech text-xs tracking-[0.2em] text-fog">
            <span />
            <span>MONTO</span>
            <span>REF</span>
            <span>FECHA</span>
          </div>
          <ul>
            {events.map((e) => {
              const topup = e.kind === "topup";
              const depOp = e.ref.startsWith("dep:");
              return (
                <li key={e.id} className="grid grid-cols-[auto_auto_1fr_auto] items-center gap-x-4 border-b border-line/60 px-4 py-3 last:border-b-0">
                  {topup ? <ArrowDown size={16} className="text-lima" /> : <ArrowUp size={16} className="text-fog" />}
                  <span className={`font-tech text-lg ${topup ? "text-lima" : "text-white"}`}>
                    {topup ? "+" : "-"}${e.amountUSDC.toFixed(4)}
                  </span>
                  <span className="truncate font-tech text-sm text-fog" title={e.ref}>
                    {depOp ? (
                      <a
                        className="underline decoration-dotted hover:text-lima"
                        href={`https://stellar.expert/explorer/testnet/op/${e.ref.slice(4)}`}
                        target="_blank"
                        rel="noreferrer"
                        title="ver pago en stellar.expert"
                      >
                        {e.ref}
                      </a>
                    ) : (
                      e.ref
                    )}
                  </span>
                  <span className="font-tech text-sm text-fog">{new Date(e.createdAt).toLocaleString()}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
