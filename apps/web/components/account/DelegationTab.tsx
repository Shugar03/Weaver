"use client";

// Delegate — MetaMask ERC-7710/7715 (spec 012). Una firma EIP-712 = un
// presupuesto acotado que el agente Weaver gasta por request sin popup.
// El gateway verifica firma+caveats con el DelegationEngine (misma semántica
// que DelegationManager.redeemDelegations on-chain) y acredita el cap al
// balance como topup dlg:<hash>. Nada se simula: sin MetaMask instalado o
// sin wallet EVM linkeada, el estado lo dice claro.
import { useCallback, useEffect, useState } from "react";
import { HandCoins, Wallet } from "@phosphor-icons/react";
import {
  delegationTemplate,
  redeemDelegation,
  listDelegations,
  type DelegationGrantView,
  type MeInfo,
} from "../../lib/account";
import { short } from "../../lib/site";

type Eip1193 = { request(args: { method: string; params?: unknown }): Promise<unknown> };
const ethereum = (): Eip1193 | null =>
  typeof window === "undefined" ? null : ((window as { ethereum?: Eip1193 }).ethereum ?? null);

const isEvm = (w: string | null | undefined): w is string => !!w && w.startsWith("0x");

export function DelegationTab({ base, token, me, onSpent }: { base: string; token: string; me: MeInfo | null; onSpent: () => void }) {
  const [grants, setGrants] = useState<DelegationGrantView[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [cap, setCap] = useState("5");
  const [ttl, setTtl] = useState("3600");
  const [busy, setBusy] = useState<"idle" | "signing" | "redeeming">("idle");

  const reload = useCallback(async () => {
    try {
      setGrants((await listDelegations(base, token)).delegations);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "error");
    }
  }, [base, token]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const sign = async () => {
    const eth = ethereum();
    if (!eth) return;
    setErr(null);
    setBusy("signing");
    try {
      const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
      const addr = accounts[0];
      if (!addr) throw new Error("MetaMask no devolvió cuenta");
      if (!isEvm(me?.walletPubkey)) throw new Error("tu cuenta no tiene wallet EVM — logueate con wallet");
      if (addr.toLowerCase() !== me!.walletPubkey!.toLowerCase()) {
        throw new Error(`MetaMask está en ${short(addr)} — conectá la wallet de tu cuenta ${short(me!.walletPubkey!)}`);
      }
      const t = await delegationTemplate(base, token, Number(cap), Number(ttl));
      const signature = (await eth.request({
        method: "eth_signTypedData_v4",
        params: [addr, JSON.stringify({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message })],
      })) as string;
      setBusy("redeeming");
      await redeemDelegation(base, token, { ...t.message, signature });
      await reload();
      onSpent(); // el balance cambió — refrescar /v1/me
    } catch (e) {
      setErr(e instanceof Error ? e.message : "error firmando");
    } finally {
      setBusy("idle");
    }
  };

  const walletOk = isEvm(me?.walletPubkey);

  return (
    <div className="space-y-4">
      <div className="border border-line bg-panel p-5">
        <div className="flex items-center gap-2 font-tech text-sm tracking-[0.2em] text-fog">
          <HandCoins size={16} className="text-lima" />
          AGENT SPENDING POWER
        </div>
        <p className="mt-2 max-w-[62ch] text-sm text-fog">
          Firmás una delegación acotada (MetaMask Delegation Framework) y el agente Weaver gasta contra ella —
          sin popup por request. El cap se acredita a tu balance; el redeem on-chain es ejecutable por el agente
          dentro de la ventana firmada.
        </p>
      </div>

      {!ethereum() ? (
        <div className="border border-line bg-panel p-8 text-center">
          <Wallet size={28} className="mx-auto text-fog" />
          <div className="mt-2 font-tech text-xl text-fog">MetaMask requerido</div>
          <p className="mx-auto mt-2 max-w-[46ch] text-sm text-fog">
            La firma de la delegación es EIP-712 (eth_signTypedData_v4). Instalá MetaMask o usá un browser
            compatible.
          </p>
        </div>
      ) : !walletOk ? (
        <div className="border border-line bg-panel p-8 text-center">
          <div className="font-tech text-xl text-fog">wallet EVM requerida</div>
          <p className="mx-auto mt-2 max-w-[46ch] text-sm text-fog">
            La delegación la firma tu wallet — logueate con MetaMask/passkey (la wallet de la cuenta es el
            delegator).
          </p>
        </div>
      ) : (
        <div className="border border-line bg-panel p-5">
          <div className="font-tech text-sm tracking-[0.2em] text-fog">NUEVA DELEGACIÓN</div>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1">
              <span className="font-tech text-xs text-fog">CAP (USDC)</span>
              <input
                value={cap}
                onChange={(e) => setCap(e.target.value)}
                inputMode="decimal"
                className="w-28 border border-line bg-ink px-3 py-2 font-tech text-lg text-white outline-none focus:border-lima"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-tech text-xs text-fog">VÁLIDA POR</span>
              <select
                value={ttl}
                onChange={(e) => setTtl(e.target.value)}
                className="border border-line bg-ink px-3 py-2 font-tech text-lg text-white outline-none focus:border-lima"
              >
                <option value="3600">1 hora</option>
                <option value="86400">1 día</option>
                <option value="604800">1 semana</option>
                <option value="2592000">30 días</option>
              </select>
            </label>
            <button
              onClick={() => void sign()}
              disabled={busy !== "idle"}
              className="border border-lima bg-lima/10 px-5 py-2 font-tech text-base tracking-[0.15em] text-lima transition hover:bg-lima hover:text-ink disabled:opacity-40"
            >
              {busy === "signing" ? "FIRMÁ EN METAMASK…" : busy === "redeeming" ? "CANJEANDO…" : "DELEGAR GASTO"}
            </button>
          </div>
          <div className="mt-2 font-tech text-xs text-fog">
            delegator = tu wallet {short(me!.walletPubkey!)} · caveats: cap USDC + expiry + solo transfer() al agente
          </div>
        </div>
      )}

      {err && <div className="border border-danger/60 px-3 py-2 font-tech text-base text-danger">{err}</div>}

      {grants === null ? (
        <div className="h-32 animate-pulse border border-line bg-panel" />
      ) : grants.length === 0 ? (
        <div className="border border-line bg-panel p-6 text-center font-tech text-base text-fog">
          sin delegaciones — la primera firma aparece acá
        </div>
      ) : (
        <div className="border border-line bg-panel">
          <div className="grid grid-cols-[auto_1fr_auto_auto] items-center gap-x-4 border-b border-line px-4 py-2 font-tech text-xs tracking-[0.2em] text-fog">
            <span>CAP</span>
            <span>HASH</span>
            <span>EXPIRA</span>
            <span>ESTADO</span>
          </div>
          <ul>
            {grants.map((g) => (
              <li key={g.hash} className="grid grid-cols-[auto_1fr_auto_auto] items-center gap-x-4 border-b border-line/60 px-4 py-3 last:border-b-0">
                <span className="font-tech text-lg text-lima">${g.amountUSDC.toFixed(2)}</span>
                <span className="truncate font-tech text-sm text-fog" title={g.hash}>
                  dlg:{short(g.hash)}
                </span>
                <span className="font-tech text-sm text-fog">
                  {g.expiresAt ? new Date(g.expiresAt).toLocaleString() : "—"}
                </span>
                <span className={`font-tech text-xs tracking-[0.15em] ${g.status === "redeemed" ? "text-lima" : "text-fog"}`}>
                  {g.status.toUpperCase()}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
