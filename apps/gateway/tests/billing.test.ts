// S47 (ADR-0007) — billing prepago: key→cuenta, 402 sin fondos, debit medido.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.ts";
import { InMemoryApiKeys } from "@weaver/api-keys";
import { InMemoryAccountStore, InMemoryCreditLedger, PricingBook } from "@weaver/accounts";
import { FakeForgeExec } from "@weaver/forge-exec";

const forges = () => [
  { forgeId: "f", model: "qwen3:4b", hot: true, rttMs: 1, queueMs: 0, loadTimeMs: 0, price: 0, reliability: 1 },
];
const pricing = new PricingBook({ "qwen3:4b": { prompt: 1_000_000n, completion: 3_000_000n, image: 0n } });

const setup = () => {
  const accounts = new InMemoryAccountStore();
  const ledger = new InMemoryCreditLedger();
  const keys = new InMemoryApiKeys();
  const exec = new FakeForgeExec({ forgeId: "f", model: "qwen3:4b" });
  const app = createApp({ forges, exec, apiKeys: keys, accounts, ledger, pricing });
  return { app, accounts, ledger, keys };
};

const chat = (secret: string) =>
  ({
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify({ model: "qwen3:4b", messages: [{ role: "user", content: "hola" }] }),
  }) as const;

const drain = async (res: Response) => {
  await res.text(); // consume el SSE completo → el debit post-stream ya corrió
};

describe("S47 billing", () => {
  it("cuenta sin fondos → 402 insufficient_credits ANTES de tocar el forge", async () => {
    const { app, accounts, keys } = setup();
    const { account } = await accounts.create();
    const { secret } = await keys.issue(account.id);
    const res = await app.request("/v1/chat/completions", chat(secret));
    assert.equal(res.status, 402);
    const j = (await res.json()) as { code: string };
    assert.equal(j.code, "insufficient_credits");
  });

  it("con fondos → sirve + debita el costo medido del usage", async () => {
    const { app, accounts, ledger, keys } = setup();
    const { account } = await accounts.create();
    await ledger.credit(account.id, 10_000_000n, "tx");
    const { secret } = await keys.issue(account.id);
    const res = await app.request("/v1/chat/completions", chat(secret));
    assert.equal(res.status, 200);
    await drain(res);
    await new Promise((r) => setTimeout(r, 50)); // el debit es fire-and-forget post-close
    const bal = await ledger.balance(account.id);
    // FakeForgeExec reporta stats medidos → debit > 0, < topup
    assert.ok(bal < 10_000_000n, `esperaba debit, balance ${bal}`);
    assert.ok(bal > 0n);
  });

  it("key sin cuenta (owner legacy) → sin billing, compat dev", async () => {
    const { app, keys } = setup();
    const { secret } = await keys.issue("dev-legacy");
    const res = await app.request("/v1/chat/completions", chat(secret));
    assert.equal(res.status, 200);
    await drain(res);
  });

  it("modelo desconocido → 404, no 402 (billing no se cobra sobre nada)", async () => {
    const { app, accounts, keys } = setup();
    const { account } = await accounts.create();
    const { secret } = await keys.issue(account.id);
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify({ model: "no-existe", messages: [{ role: "user", content: "x" }] }),
    });
    assert.equal(res.status, 404);
  });

  it("sin accounts/ledger en Deps → key acct_ no existe, nada cambia", async () => {
    const keys = new InMemoryApiKeys();
    const { secret } = await keys.issue("cualquiera");
    const app = createApp({ forges, exec: new FakeForgeExec({ forgeId: "f", model: "qwen3:4b" }), apiKeys: keys });
    const res = await app.request("/v1/chat/completions", chat(secret));
    assert.equal(res.status, 200);
    await drain(res);
  });

  it("imagen: sin fondos → 402; con fondos → debita flat post-gen", async () => {
    const accounts = new InMemoryAccountStore();
    const ledger = new InMemoryCreditLedger();
    const keys = new InMemoryApiKeys();
    const imgPricing = new PricingBook({ "flux": { prompt: 0n, completion: 0n, image: 500_000n } });
    const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
    const app = createApp({
      forges: () => [
        { forgeId: "img", model: "flux", capability: "image" as const, hot: false, rttMs: 5, queueMs: 0, loadTimeMs: 100, price: 0, reliability: 1 },
      ],
      imageExecs: {
        img: { forgeId: "img", model: "flux", generateImage: async () => ({ forgeId: "img", b64: PNG, ms: 9 }) },
      },
      apiKeys: keys,
      accounts,
      ledger,
      pricing: imgPricing,
    });
    const { account } = await accounts.create();
    const { secret } = await keys.issue(account.id);
    const gen = () => ({
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify({ model: "flux", prompt: "un telar" }),
    });
    // sin fondos → 402
    assert.equal((await app.request("/v1/images/generations", gen())).status, 402);
    // fondear → sirve y debita 500_000 flat
    await ledger.credit(account.id, 1_000_000n, "tx");
    const res = await app.request("/v1/images/generations", gen());
    assert.equal(res.status, 200);
    await res.json();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(await ledger.balance(account.id), 500_000n);
  });
});
