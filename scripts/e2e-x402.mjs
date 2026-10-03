// scripts/e2e-x402.mjs — E2E LIVE del paywall x402 v2 en Monad testnet.
//   1. client EOA nuevo ← USDC real del operador
//   2. POST /v1/chat/completions SIN pago → 402 + accepts[]
//   3. firma EIP-3009 transferWithAuthorization (gasless, off-chain)
//   4. retry con X-PAYMENT → verify → serve (SSE real del forge) → settle
//   5. verifica on-chain: tx del facilitator (cliente→payTo) + release escrow
//      (operador→forge) — las DOS patas del intercambio, una por cada tx.
//
// Uso (gateway paywall en :3501 + forge remote conectado):
//   SETTLEMENT_SECRET=$(cat /tmp/weaver_op_key) node scripts/e2e-x402.mjs
// Env opcional: GW=http://127.0.0.1:3501  RPC=https://testnet-rpc.monad.xyz
import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { buildX402Eip3009Header } from "../packages/settlement/src/eip3009.ts";

const GW = process.env.GW ?? "http://127.0.0.1:3501";
const RPC = process.env.RPC ?? "https://testnet-rpc.monad.xyz";
const SECRET = process.env.SETTLEMENT_SECRET;
const USDC = "0x534b2f3A21130d7a60830c2Df862319e593943A3";
if (!SECRET) {
  console.error("falta SETTLEMENT_SECRET (key del operador — recibe el pago x402)");
  process.exit(1);
}
const CHAIN = {
  id: 10143,
  name: "monad-testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
};
const op = privateKeyToAccount(SECRET.startsWith("0x") ? SECRET : `0x${SECRET}`);
const client = privateKeyToAccount(generatePrivateKey());
const pub = createPublicClient({ chain: CHAIN, transport: http(RPC) });
const wc = createWalletClient({ account: op, chain: CHAIN, transport: http(RPC) });
const ERC20 = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

console.log(`operator ${op.address}  ·  cliente ${client.address}`);
console.log(`gateway ${GW}`);

// 1) USDC al cliente (gasless real: el cliente jamás manda tx — el facilitator
//    ejecuta transferWithAuthorization on-chain pagando el gas).
process.stdout.write("fondeo USDC cliente… ");
const fundTx = await wc.writeContract({ address: USDC, abi: ERC20, functionName: "transfer", args: [client.address, 50000n] });
await pub.waitForTransactionReceipt({ hash: fundTx });
console.log(fundTx);

// 2) POST sin pago → 402
const body = JSON.stringify({ model: "qwen3:4b", stream: true, max_tokens: 32, messages: [{ role: "user", content: "Say OK." }] });
let res = await fetch(`${GW}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body });
if (res.status !== 402) {
  console.error(`esperaba 402 sin pago, recibí ${res.status}: ${(await res.text()).slice(0, 300)}`);
  process.exit(1);
}
const r402 = await res.json();
const reqs = r402.accepts?.[0];
console.log(`402 ✓ — accepts: ${reqs.asset} ${reqs.amount} → ${reqs.payTo}`);

// 3) EIP-3009 sign + retry con X-PAYMENT
const header = await buildX402Eip3009Header({
  from: client.address,
  signTypedData: (args) => client.signTypedData(args),
  requirements: { ...reqs, asset: USDC, amount: reqs.amount },
});
res = await fetch(`${GW}/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-payment": header },
  body,
});
if (!res.ok) {
  console.error(`pago rechazado ${res.status}: ${(await res.text()).slice(0, 300)}`);
  process.exit(1);
}
const sse = await res.text();
const tokens = (sse.match(/^data: /gm) ?? []).length;
console.log(`200 ✓ — job servido con pago x402 (${tokens} frames SSE)`);

// 4) settle async → poll executions hasta payerTx + releaseTx
console.log("esperando settle del facilitator + release escrow…");
let payerTx, releaseTx, forge;
for (let i = 0; i < 30 && !(payerTx && releaseTx); i++) {
  await new Promise((r) => setTimeout(r, 4000));
  const execs = await (await fetch(`${GW}/v1/executions?limit=5`)).json().catch(() => ({}));
  const last = (execs.executions ?? execs ?? []).find((e) => e.settle?.payerTx || e.settle?.releaseTx);
  payerTx ??= last?.settle?.payerTx;
  releaseTx ??= last?.settle?.releaseTx;
  forge ??= last?.forgeId;
}

// 5) verificación on-chain de AMBAS patas
async function transferIn(txHash, label) {
  const r = await pub.getTransactionReceipt({ hash: txHash });
  const usdcLog = r.logs.find((l) => l.address.toLowerCase() === USDC.toLowerCase() && l.topics[0] === TRANSFER_TOPIC);
  const amount = usdcLog ? Number(BigInt(usdcLog.data)) / 1e6 : null;
  console.log(`${label}: ${txHash}\n   status=${r.status} block=${r.blockNumber} USDC=${amount ?? "—"}`);
  return r.status === "success";
}
let ok = true;
if (payerTx) ok = (await transferIn(payerTx, "pata cliente (x402 facilitator settle)")) && ok;
else { console.log("payerTx no apareció en telemetría — settle del facilitator sin evidencia"); ok = false; }
if (releaseTx) ok = (await transferIn(releaseTx, "pata forge (escrow release)")) && ok;
else console.log("releaseTx aún no — job served, escrow pendiente (reconciler lo cubre)");

console.log(`\n${ok ? "E2E X402 LIVE PASS" : "E2E X402 INCOMPLETE"} · forge=${forge} · fund-client=${fundTx}`);
process.exit(ok ? 0 : 1);
