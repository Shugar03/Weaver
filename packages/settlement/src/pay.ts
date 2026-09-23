// Pago clásico por Horizon (no Soroban) — distinto del escrow: esto es un
// transfer directo cuenta→cuenta con memo. Uso real: el e2e-live fondea una
// cuenta Weaver con USDC+memo para ejercitar el DepositWatcher end-to-end.
import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

export async function stellarPay(opts: {
  secret: string; // S... del funder
  horizon: string; // Horizon URL
  destination: string; // G... deposit address del operador
  amount: string; // unidades del asset ("0.50")
  memo: string; // memo text — el DepositWatcher lo mapea a la cuenta
  assetCode: string; // "USDC"
  issuer: string; // G... issuer del asset
  testnet?: boolean; // default true
}): Promise<{ hash: string; ledger: number }> {
  const server = new Horizon.Server(opts.horizon);
  const kp = Keypair.fromSecret(opts.secret);
  const source = await server.loadAccount(kp.publicKey());
  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: opts.testnet === false ? Networks.PUBLIC : Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: opts.destination,
        asset: new Asset(opts.assetCode, opts.issuer),
        amount: opts.amount,
      }),
    )
    // Memo text: máx 28 bytes — accountId "acct_<hex>" entra de sobra.
    .addMemo(Memo.text(opts.memo.slice(0, 28)))
    .setTimeout(60)
    .build();
  tx.sign(kp);
  const res = await server.submitTransaction(tx);
  return { hash: res.hash, ledger: res.ledger };
}
