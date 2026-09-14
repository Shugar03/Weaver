const EXPLORER_TX = "https://stellar.expert/explorer/testnet/tx/";
const EXPLORER_CONTRACT = "https://stellar.expert/explorer/testnet/contract/";
const EXPLORER_ACCOUNT = "https://stellar.expert/explorer/testnet/account/";

type Deployment = {
  contract_id: string;
  admin: string;
  worker?: string;
  token_usdc_sac: string;
  txs: Record<string, string>;
};

const TX_LABELS: [string, string][] = [
  ["release_job_1", "Release"],
  ["fund_job_1", "Fund"],
  ["init", "Init"],
  ["deploy_contract", "Deploy"],
];

function short(h: string) {
  return h.length > 12 ? `${h.slice(0, 4)}...${h.slice(-4)}` : h;
}

export function ProofSection({ deployment }: { deployment: Deployment | null }) {
  if (!deployment) {
    return (
      <div className="border border-line bg-panel p-8 font-tech text-xl text-fog">
        <span className="text-danger">■</span> SIN DEPLOY REGISTRADO — ver contracts/weaver-escrow/deployments/testnet.json
      </div>
    );
  }
  const txs = TX_LABELS.filter(([k]) => deployment.txs[k]).map(([k, label]) => ({
    label,
    hash: deployment.txs[k] as string,
  }));
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
      <div className="border border-line bg-panel p-6 lg:col-span-3">
        <div className="flex items-center justify-between">
          <span className="font-tech text-lg tracking-[0.18em] text-fog">CONTRACT</span>
          <span className="border border-lima px-2 py-0.5 font-tech text-sm tracking-[0.15em] text-lima">● VERIFIED</span>
        </div>
        <a
          href={`${EXPLORER_CONTRACT}${deployment.contract_id}`}
          target="_blank"
          rel="noreferrer"
          className="mt-2 block font-tech text-3xl tracking-wide hover:text-lima"
        >
          {short(deployment.contract_id)} ↗
        </a>
        <div className="mt-1 font-tech text-base text-fog">Deployed on Stellar · Soroban · Testnet</div>
        <div className="mt-6 border-t border-line pt-4 font-tech text-lg tracking-[0.18em] text-fog">
          LATEST TRANSACTIONS
        </div>
        <ul className="mt-2">
          {txs.map((t, i) => (
            <li key={t.hash} className="relative border-l border-line pb-5 pl-6 last:pb-0">
              <span
                className={`absolute top-1.5 -left-[5px] h-2 w-2 rounded-full ${
                  i === 0 ? "bg-lima" : i === 1 ? "border border-lima" : "bg-fog"
                }`}
              />
              <div className="flex items-center justify-between">
                <span className="font-tech text-xl">{t.label}</span>
                <a href={`${EXPLORER_TX}${t.hash}`} target="_blank" rel="noreferrer" className="font-tech text-lg text-fog hover:text-lima">
                  {short(t.hash)} ↗
                </a>
              </div>
            </li>
          ))}
        </ul>
      </div>
      <div className="border border-line bg-panel p-6 lg:col-span-2">
        <div className="font-tech text-lg tracking-[0.18em] text-fog">ACCOUNTS (USDC TESTNET)</div>
        {[
          ["Client", deployment.admin],
          ["Escrow", deployment.contract_id],
          ...(deployment.worker ? [["Worker", deployment.worker] as [string, string]] : []),
        ].map(([label, addr]) => (
          <a
            key={label}
            href={`${EXPLORER_ACCOUNT}${addr}`}
            target="_blank"
            rel="noreferrer"
            className="mt-3 flex items-center justify-between border border-line px-4 py-3 hover:border-lima"
          >
            <span className="font-tech text-xl">{label}</span>
            <span className="font-tech text-lg text-fog">{short(addr)} ↗</span>
          </a>
        ))}
        <div className="mt-4 font-tech text-base leading-snug text-fog">
          Balances en vivo en el explorer. Nada acá es snapshot: cada link es una tx real.
        </div>
      </div>
    </div>
  );
}
