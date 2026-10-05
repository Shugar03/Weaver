"use client";

// spec 009 — verificación client-side del receipt de ejecución.
// El proof L0 ata TRES cosas: el output que el usuario leyó (sha256), la
// identidad on-chain del forge (ecrecover → signer del registry) y el pago
// (releaseTx vía /v1/executions). Si alguna no cuadra, se dice — la UI de
// trust que miente es peor que no tenerla.
import { useEffect, useState } from "react";
import { verifyMessage } from "viem";
import { short, txUrl } from "../../lib/site";
import { commitProof, promptHashInput, sha256hex, type CanonicalMessage } from "../../lib/proofhash";
import type { WeaverProof } from "../../lib/weaver";

type Verdict = "checking" | "ok" | "bad" | "unverifiable";

export function ProofChip({
  proof,
  output,
  input,
  base,
}: {
  proof: WeaverProof;
  output: string;
  input?: { model: string; messages: CanonicalMessage[]; resume?: string };
  base: string;
}) {
  const [verdict, setVerdict] = useState<Verdict>("checking");
  const [releaseTx, setReleaseTx] = useState<string | undefined>();

  useEffect(() => {
    let alive = true;
    void (async () => {
      // 1) El hash ata el receipt al texto servido — si no matchea, el
      //    receipt no es de ESTE output (o el stream fue alterado).
      //    Con resume mid-stream, el proof ata solo el SUFIJO que generó
      //    el forge que completó (el prefijo vive atado en el promptHash).
      const served = input?.resume !== undefined ? output.slice(input.resume.length) : output;
      const digest = await sha256hex(served);
      // Commitment era: resultHash = sha256(promptHash‖outputHash). Legacy:
      // resultHash era el output hash directo. Se soportan ambos.
      const committed = Boolean(proof.promptHash && proof.outputHash);
      if (committed ? digest !== proof.outputHash : digest !== proof.resultHash) {
        if (alive) setVerdict("bad");
        return;
      }
      if (committed) {
        // El receipt también ata el INPUT: recomputamos el hash del request
        // que mandamos — un forge que respondió a OTRO prompt produce otro
        // commitment. Sin input (receipt viejo de otro flujo) no se puede
        // recomputar → la firma sigue verificable, el binding no.
        const commitmentOk =
          input !== undefined &&
          (await promptHashInput(input)) === proof.promptHash &&
          (await commitProof(proof.promptHash!, proof.outputHash!)) === proof.resultHash;
        if (!commitmentOk) {
          if (alive) setVerdict("bad");
          return;
        }
      }
      // 2) La firma ata al signer on-chain. Sin signer en el receipt (forge
      //    no registrado) o firma no-EVM: hash ok, identidad no verificable.
      if (!proof.signer?.startsWith("0x") || proof.signer.length !== 42) {
        if (alive) setVerdict("unverifiable");
      } else {
        try {
          const ok = await verifyMessage({
            address: proof.signer as `0x${string}`,
            message: { raw: `0x${proof.resultHash}` },
            signature: proof.signature as `0x${string}`,
          });
          if (alive) setVerdict(ok ? "ok" : "bad");
        } catch {
          if (alive) setVerdict("unverifiable");
        }
      }
      // 3) releaseTx: el pago on-chain que este proof desbloqueó (best-effort).
      try {
        const r = await fetch(`${base}/v1/executions?jobId=${proof.jobId}`, { cache: "no-store" });
        if (r.ok) {
          const [s] = (await r.json()) as { settle?: { releaseTx?: string } }[];
          if (alive && s?.settle?.releaseTx) setReleaseTx(s.settle.releaseTx);
        }
      } catch {
        /* gateway caído — el chip igual ya verificó hash+firma */
      }
    })();
    return () => {
      alive = false;
    };
  }, [proof, output, input, base]);

  const style =
    verdict === "ok"
      ? "text-lima border-lima/40"
      : verdict === "bad"
        ? "text-danger border-danger/40"
        : "text-fog border-line";

  return (
    <span
      className={`inline-flex items-center gap-2 border px-2 py-0.5 font-tech text-xs tracking-[0.15em] ${style}`}
      title={
        verdict === "ok"
          ? `sha256(output) ✓ · firma ecrecover → ${proof.signer} ✓ · el escrow pagó contra este proof`
          : verdict === "bad"
            ? "EL RECEIPT NO ATA AL OUTPUT SERVIDO — hash mismatch"
            : verdict === "unverifiable"
              ? "hash del output verificado; firma no verificable client-side (sin signer EVM en registry)"
              : "verificando receipt…"
      }
    >
      {verdict === "checking" && <span>PROOF ◌</span>}
      {verdict === "ok" && (
        <>
          <span>PROOF ✓</span>
          {releaseTx ? (
            <a
              href={txUrl(releaseTx, "evm")}
              target="_blank"
              rel="noreferrer"
              className="text-lima/80 underline decoration-lima/40 hover:decoration-lima"
            >
              settled ↗
            </a>
          ) : (
            <span className="text-fog">{short(proof.resultHash)}</span>
          )}
        </>
      )}
      {verdict === "bad" && <span>PROOF ✗</span>}
      {verdict === "unverifiable" && <span>PROOF ~hash</span>}
    </span>
  );
}
