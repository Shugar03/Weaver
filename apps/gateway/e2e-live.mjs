#!/usr/bin/env node
// e2e-live — smoke de PLATA REAL contra testnet (ADR-0007 E2E).
// Corre el loop completo del consumidor contra un gateway en vivo:
//
//   cuenta → depósito USDC on-chain → key → chat servido → debit medido →
//   ledger visible → catálogo con métricas reales
//
// Prereqs: gateway corriendo con DATABASE_URL + watcher (DEPOSIT_ADDRESS +
// USDC_ISSUER) + forge sirviendo el modelo. Con SETTLEMENT_* también verifica
// la pata on-chain del forge.
//
// Uso:
//   GATEWAY=http://localhost:3001 \
//   FUNDER_SECRET=S...        # cuenta testnet con USDC (friendbot + trustline)
//   USDC_ISSUER=G...          # issuer del USDC testnet aceptado
//   TOPUP_USDC=0.50           # opcional, default 0.25
//   MODEL=qwen3:4b            # opcional, default: primer modelo LIVE del catálogo
//   node apps/gateway/e2e-live.mjs
//
// Sin FUNDER_SECRET corre en modo "dry": crea cuenta+key pero el chat
// devolverá 402 (honesto) — útil para probar el flujo sin mover plata.
import { stellarPay } from "@weaver/settlement";

const GATEWAY = (process.env.GATEWAY ?? "http://localhost:3001").replace(/\/$/, "");
const FUNDER = process.env.FUNDER_SECRET ?? null;
const ISSUER = process.env.USDC_ISSUER ?? null;
const CODE = process.env.USDC_CODE ?? "USDC";
const TOPUP = process.env.TOPUP_USDC ?? "0.25";
const HORIZON = process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org";
const EXPLORER = "https://stellar.expert/explorer/testnet";

const ok = (s) => console.log(`  ✓ ${s}`);
const fail = (s) => {
  console.error(`  ✗ ${s}`);
  process.exitCode = 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const req = async (path, { token, method = "GET", body } = {}) => {
  const r = await fetch(`${GATEWAY}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, json: j };
};

console.log(`\nweaver e2e-live → ${GATEWAY}\n`);

// 1. gateway vivo
const st = await req("/v1/status");
if (st.status !== 200) {
  fail(`gateway sin respuesta en ${GATEWAY} — levantalo primero`);
  process.exit(1);
}
ok(`gateway up (v${st.json.version}, uptime ${Math.round(st.json.uptimeMs / 1000)}s)`);

// 2. cuenta
const acct = await req("/v1/accounts", { method: "POST" });
if (acct.status !== 201) {
  fail(`POST /v1/accounts → ${acct.status} ${JSON.stringify(acct.json)}`);
  process.exit(1);
}
const { accountId, mgmtToken, depositMemo } = acct.json;
ok(`cuenta ${accountId} · memo ${depositMemo}`);

const me0 = await req("/v1/me", { token: mgmtToken });
const depositAddress = me0.json.depositAddress;
if (!depositAddress) {
  // Watcher off es config válida en dev — solo es fail si quiero fondear.
  console.log("  (depositAddress ausente — watcher off; en dry es ok)");
} else {
  ok(`deposit address ${depositAddress.slice(0, 12)}…`);
}

// 3. fondeo on-chain (si hay funder)
if (FUNDER && ISSUER && depositAddress) {
  console.log(`  → enviando ${TOPUP} ${CODE} on-chain (memo=${depositMemo})…`);
  const pay = await stellarPay({
    secret: FUNDER,
    horizon: HORIZON,
    destination: depositAddress,
    amount: TOPUP,
    memo: depositMemo,
    assetCode: CODE,
    issuer: ISSUER,
  });
  ok(`pago enviado ${EXPLORER}/tx/${pay.hash} (ledger ${pay.ledger})`);

  // el watcher pollea Horizon — esperar a que acredite
  let balance = 0;
  for (let i = 0; i < 45; i++) {
    await sleep(2000);
    const me = await req("/v1/me", { token: mgmtToken });
    balance = me.json.balanceUSDC ?? 0;
    if (balance > 0) break;
    if (i % 5 === 4) console.log(`    …esperando al watcher (${(i + 1) * 2}s)`);
  }
  if (balance > 0) ok(`watcher acreditó — balance $${balance.toFixed(4)} USDC`);
  else fail("90s sin acreditar — revisá el watcher (DEPOSIT_ADDRESS/USDC_ISSUER/memo)");
} else if (FUNDER && (!ISSUER || !depositAddress)) {
  fail("FUNDER_SECRET sin USDC_ISSUER o sin depositAddress en el gateway — no se puede fondear");
} else {
  console.log("  (sin FUNDER_SECRET/USDC_ISSUER — modo dry, el chat devolverá 402)");
}

// 4. API key self-serve
const key = await req("/v1/me/keys", { method: "POST", token: mgmtToken });
if (key.status !== 201) {
  fail(`POST /v1/me/keys → ${key.status}`);
  process.exit(1);
}
ok(`api key ${key.json.id} emitida (secret wvr_… mostrado una vez)`);

// 5. modelo a probar — primero LIVE del catálogo
const cat = await req("/v1/catalog");
const models = cat.json?.models ?? [];
const target = process.env.MODEL ?? models.find((m) => m.availability?.available && !m.features?.includes("image"))?.id;
if (!target) {
  fail("catálogo sin modelos live de texto — ¿hay forges sirviendo?");
  process.exit(1);
}
ok(`modelo elegido: ${target} (${models.find((m) => m.id === target)?.availability.providers ?? "?"} providers)`);

// 6. chat real con la key (SSE)
console.log("  → chat completions (stream)…");
const chat = await fetch(`${GATEWAY}/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${key.json.secret}` },
  body: JSON.stringify({
    model: target,
    messages: [{ role: "user", content: "Respondé solo: ok" }],
    stream: true,
    max_tokens: 16,
  }),
});
if (chat.status === 402) {
  if (FUNDER) {
    fail("402 pese a fondeo — revisá watcher/pricing (balance post-topup)");
  } else {
    // En dry el 402 ES la verificación: el billing gate rechaza antes de
    // tocar un forge — un serve gratis a cuenta vacía sería el bug.
    ok("402 correcto: sin fondos no se sirve (billing gate verificado)");
  }
} else if (chat.status !== 200 || !chat.body) {
  fail(`chat → ${chat.status}`);
} else {
  let text = "";
  let usage = null;
  const reader = chat.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buf += dec.decode(value, { stream: !done });
    for (;;) {
      const i = buf.indexOf("\n\n");
      if (i < 0) break;
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of frame.split("\n")) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const data = t.slice(5).trim();
        if (data === "[DONE]") break;
        try {
          const j = JSON.parse(data);
          if (j.error) {
            fail(`stream error: ${j.error} ${j.detail ?? ""}`);
            done || process.exit(1);
          }
          text += j.choices?.[0]?.delta?.content ?? "";
          if (j.usage) usage = j.usage;
        } catch {
          /* keepalive */
        }
      }
    }
    if (done) break;
  }
  ok(`stream completo: "${text.trim().slice(0, 60)}" · usage ${JSON.stringify(usage ?? {})}`);
}

// 7. ledger: el debit medido post-stream
await sleep(1500); // el debit es post-serve
const bill = await req("/v1/me/billing", { token: mgmtToken });
const debits = (bill.json.events ?? []).filter((e) => e.kind === "debit");
const topups = (bill.json.events ?? []).filter((e) => e.kind === "topup");
if (debits.length > 0) {
  ok(`debit medido en ledger: -$${debits[0].amountUSDC.toFixed(4)} (ref ${debits[0].ref})`);
} else if (FUNDER) {
  fail("chat ok pero sin debit en ledger — revisá pricing/billing path");
} else {
  console.log("  (dry: sin debit esperable — no hubo serve)");
}
if (topups.length > 0) ok(`topup en ledger: +$${topups[0].amountUSDC.toFixed(4)} (ref ${topups[0].ref})`);

// 7b. pata forge: el sample del job debe mostrar settle on-chain si el
// gateway corre con SETTLEMENT_* — fundTx+releaseTx son links a expert.
const execs = await req("/v1/executions?limit=10");
const mine = (execs.json ?? []).find((s) => s.ok && s.model === target);
if (mine?.settle?.status === "settled") {
  ok("forge pagado on-chain (settle.settled en el sample)");
  if (mine.settle.fundTx) console.log(`    fund:    ${EXPLORER}/tx/${mine.settle.fundTx}`);
  if (mine.settle.releaseTx) console.log(`    release: ${EXPLORER}/tx/${mine.settle.releaseTx}`);
} else if (mine?.settle?.status === "failed") {
  fail(`settle del forge FAILED — revisá SETTLEMENT_CONTRACT (¿v3 vs v4?)`);
} else {
  console.log("  (sin settle en el sample — settlement off en este gateway, ok en dev)");
}

// 8. catálogo post-serve: debería tener medidas frescas
const cat2 = await req("/v1/catalog");
const m2 = cat2.json?.models?.find((m) => m.id === target);
if (m2?.measured?.ttftMsP50 != null) {
  ok(`catálogo medido: TTFT p50 ${m2.measured.ttftMsP50}ms · tok/s ${m2.measured.tokPerSec?.toFixed(1) ?? "—"}`);
} else {
  console.log("  (catálogo sin medidas todavía — p50 tarda un poll en aparecer)");
}

console.log(`\nresumen:
  cuenta:   ${accountId}
  balance:  $${(bill.json.balanceUSDC ?? 0).toFixed(4)} USDC
  ledger:   ${topups.length} topup(s) · ${debits.length} debit(s)
  explorer: ${depositAddress ? `${EXPLORER}/account/${depositAddress}` : "(sin deposit address — watcher off)"}
${process.exitCode ? "\nFALLOS — ver arriba" : "\nloop completo verificado ✓"}\n`);
