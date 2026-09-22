"use client";

// Keys — CRUD self-serve. El secreto se muestra UNA vez al crear (modal
// inline, no se guarda en claro en ningún lado). Revoke con confirm.
// Empty state que enseña qué hacer con la key (Paradox of the Active User).
import { useCallback, useEffect, useState } from "react";
import { Copy, Check, Trash, Plus, Warning } from "@phosphor-icons/react";
import { createKey, listKeys, revokeKey, type KeyPublic } from "../../lib/account";

export function KeysTab({ base, token }: { base: string; token: string }) {
  const [keys, setKeys] = useState<KeyPublic[] | null>(null);
  const [fresh, setFresh] = useState<{ id: string; secret: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const reload = useCallback(async () => {
    try {
      setKeys(await listKeys(base, token));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "error");
    }
  }, [base, token]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function create() {
    setBusy(true);
    setErr(null);
    try {
      setFresh(await createKey(base, token));
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "error");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setBusy(true);
    try {
      await revokeKey(base, token, id);
      setConfirmId(null);
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* secreto recién creado — una sola vez */}
      {fresh && (
        <div className="border border-lima/60 bg-panel p-5">
          <div className="flex items-center gap-2 font-tech text-base tracking-[0.2em] text-lima">
            <Warning size={16} /> KEY CREADA — SE MUESTRA UNA SOLA VEZ
          </div>
          <div className="mt-3 flex items-center gap-2 border border-line bg-void px-3 py-2">
            <code className="flex-1 overflow-x-auto font-tech text-base whitespace-nowrap text-lima">{fresh.secret}</code>
            <button
              onClick={() => void navigator.clipboard.writeText(fresh.secret).then(() => setCopied(true))}
              className="text-fog hover:text-lima"
              title="copiar"
            >
              {copied ? <Check size={18} /> : <Copy size={18} />}
            </button>
          </div>
          <p className="mt-2 text-sm text-fog">
            Guardala en tu cliente (opencode, pi, hermes). Si la perdés, revocá y creá otra.
          </p>
          <button
            onClick={() => setFresh(null)}
            className="mt-3 border border-line px-4 py-2 font-tech text-base text-fog hover:text-white"
          >
            LISTO, LA GUARDÉ
          </button>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className="font-tech text-base tracking-[0.2em] text-fog">
          {keys ? `${keys.filter((k) => !k.revoked).length} KEYS ACTIVAS` : "KEYS"}
        </div>
        <button
          onClick={() => void create()}
          disabled={busy}
          className="flex items-center gap-2 bg-lima px-4 py-2 font-tech text-base tracking-[0.15em] text-black transition-colors hover:bg-white disabled:opacity-50"
        >
          <Plus size={16} weight="bold" /> CREAR KEY
        </button>
      </div>
      {err && <div className="border border-danger/60 px-3 py-2 font-tech text-base text-danger">{err}</div>}

      {keys === null ? (
        <div className="h-32 animate-pulse border border-line bg-panel" />
      ) : keys.filter((k) => !k.revoked).length === 0 ? (
        <div className="border border-line bg-panel p-8 text-center">
          <div className="font-tech text-xl text-fog">todavía no tenés keys</div>
          <p className="mx-auto mt-2 max-w-[46ch] text-sm text-fog">
            Una key <span className="font-tech text-white">wvr_…</span> es lo que va en el campo
            <span className="font-tech text-white"> api_key</span> de cualquier cliente OpenAI-compatible.
            El billing cae en esta cuenta.
          </p>
        </div>
      ) : (
        <div className="border border-line bg-panel">
          <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-4 border-b border-line px-4 py-2 font-tech text-xs tracking-[0.2em] text-fog">
            <span>KEY ID</span>
            <span>CREADA</span>
            <span>ESTADO</span>
            <span />
          </div>
          <ul>
            {keys.map((k) => (
              <li key={k.id} className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-4 border-b border-line/60 px-4 py-3 last:border-b-0">
                <span className="truncate font-tech text-base text-white" title={k.id}>{k.id}</span>
                <span className="font-tech text-sm text-fog">{new Date(k.createdAt).toLocaleDateString()}</span>
                <span className={`font-tech text-sm tracking-[0.15em] ${k.revoked ? "text-danger" : "text-lima"}`}>
                  {k.revoked ? "REVOKED" : "ACTIVE"}
                </span>
                {k.revoked ? (
                  <span />
                ) : confirmId === k.id ? (
                  <span className="flex gap-2">
                    <button onClick={() => void revoke(k.id)} disabled={busy} className="font-tech text-sm text-danger hover:text-white">
                      CONFIRMAR
                    </button>
                    <button onClick={() => setConfirmId(null)} className="font-tech text-sm text-fog hover:text-white">
                      no
                    </button>
                  </span>
                ) : (
                  <button onClick={() => setConfirmId(k.id)} className="text-fog transition-colors hover:text-danger" title="revocar">
                    <Trash size={16} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
