// S47 (ADR-0007) — rutas de cuenta: creación, auth dual, keys CRUD, billing view.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.ts";
import { InMemoryApiKeys } from "@weaver/api-keys";
import { InMemoryAccountStore, InMemoryCreditLedger, PricingBook } from "@weaver/accounts";
import { NonceStore } from "@weaver/forge-net";
import { stellarKeypair, stellarVerify } from "@weaver/settlement";

const forges = () => [
  { forgeId: "f", model: "qwen3:4b", hot: true, rttMs: 1, queueMs: 0, loadTimeMs: 0, price: 0, reliability: 1 },
];

const setup = () => {
  const accounts = new InMemoryAccountStore();
  const ledger = new InMemoryCreditLedger();
  const keys = new InMemoryApiKeys();
  const app = createApp({
    forges,
    apiKeys: keys,
    accounts,
    ledger,
    pricing: new PricingBook({ "qwen3:4b": { prompt: 1_000_000n, completion: 3_000_000n, image: 0n } }),
    meChallenges: new NonceStore(),
    verifyWalletSig: stellarVerify,
  });
  return { app, accounts, ledger, keys };
};

describe("S47 rutas de cuenta", () => {
  it("POST /v1/accounts → accountId + mgmtToken + depositMemo (una vez)", async () => {
    const { app } = setup();
    const res = await app.request("/v1/accounts", { method: "POST" });
    assert.equal(res.status, 201);
    const j = (await res.json()) as { accountId: string; mgmtToken: string; depositMemo: string };
    assert.match(j.accountId, /^acct_/);
    assert.match(j.mgmtToken, /^wvr_acct_/);
    assert.equal(j.depositMemo, j.accountId);
  });

  it("GET /v1/me con mgmt token → balance + memo; sin token → 401; trucho → 401", async () => {
    const { app, ledger } = setup();
    const { mgmtToken, accountId } = (await (
      await app.request("/v1/accounts", { method: "POST" })
    ).json()) as { mgmtToken: string; accountId: string };
    await ledger.credit(accountId, 7_000_000n, "tx1");

    const me = await app.request("/v1/me", { headers: { authorization: `Bearer ${mgmtToken}` } });
    assert.equal(me.status, 200);
    const j = (await me.json()) as { accountId: string; balanceStroops: string; depositMemo: string };
    assert.equal(j.accountId, accountId);
    assert.equal(j.balanceStroops, "7000000");
    assert.equal(j.depositMemo, accountId);

    assert.equal((await app.request("/v1/me")).status, 401);
    assert.equal(
      (await app.request("/v1/me", { headers: { authorization: "Bearer wvr_acct_trucho" } })).status,
      401,
    );
  });

  it("wallet: challenge → firma → sesión; nonce single-use; firma trucha → 401", async () => {
    const { app, accounts } = setup();
    const kp = stellarKeypair();
    const pubkey = kp.pubkey;
    const sign = kp.sign;

    const ch = (await (await app.request("/v1/me/challenge", { method: "POST" })).json()) as {
      nonce: string;
    };
    const sig = sign(Buffer.from(`weaver-login:${ch.nonce}`)).toString("hex");
    const ses = await app.request("/v1/me/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pubkey, nonce: ch.nonce, signature: sig }),
    });
    assert.equal(ses.status, 200);
    const { sessionToken, accountId } = (await ses.json()) as { sessionToken: string; accountId: string };
    assert.match(sessionToken, /^wvr_sess_/);
    // la cuenta quedó creada y atada a la wallet
    assert.equal((await accounts.byWallet(pubkey))?.id, accountId);

    // la sesión autentica /v1/me
    const me = await app.request("/v1/me", { headers: { authorization: `Bearer ${sessionToken}` } });
    assert.equal(me.status, 200);

    // replay del nonce → 401
    const replay = await app.request("/v1/me/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pubkey, nonce: ch.nonce, signature: sig }),
    });
    assert.equal(replay.status, 401);

    // firma sobre otro mensaje → 401
    const ch2 = (await (await app.request("/v1/me/challenge", { method: "POST" })).json()) as { nonce: string };
    const bad = await app.request("/v1/me/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pubkey, nonce: ch2.nonce, signature: sign(Buffer.from("otro")).toString("hex") }),
    });
    assert.equal(bad.status, 401);
  });

  it("keys self-serve: create/list/revoke propias; ajenas → 404; sin auth → 401", async () => {
    const { app } = setup();
    const mk = async () => {
      const r = await app.request("/v1/accounts", { method: "POST" });
      return ((await r.json()) as { mgmtToken: string }).mgmtToken;
    };
    const a = await mk();
    const b = await mk();
    const authA = { authorization: `Bearer ${a}` };

    const created = await app.request("/v1/me/keys", { method: "POST", headers: authA });
    assert.equal(created.status, 201);
    const { id, secret } = (await created.json()) as { id: string; secret: string };
    assert.match(secret, /^wvr_/);

    // lista solo las propias
    const list = await app.request("/v1/me/keys", { headers: authA });
    const mine = (await list.json()) as { id: string }[];
    assert.equal(mine.length, 1);
    assert.equal(mine[0]!.id, id);
    const listB = await app.request("/v1/me/keys", { headers: { authorization: `Bearer ${b}` } });
    assert.equal(((await listB.json()) as unknown[]).length, 0);

    // la key creada autentica como API key (Bearer) — el puente a billing
    const jobs = await app.request("/v1/jobs", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify({ model: "qwen3:4b" }),
    });
    assert.equal(jobs.status, 200);

    // B no puede revocar la key de A (404, no 403 — no filtrar existencia)
    const del = await app.request(`/v1/me/keys/${id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${b}` },
    });
    assert.equal(del.status, 404);
    const delOk = await app.request(`/v1/me/keys/${id}`, { method: "DELETE", headers: authA });
    assert.equal(delOk.status, 200);
    // revocada → 401 en Bearer
    const gated = await app.request("/v1/jobs", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify({ model: "qwen3:4b" }),
    });
    assert.equal(gated.status, 401);

    assert.equal((await app.request("/v1/me/keys", { method: "POST" })).status, 401);
  });

  it("GET /v1/me/billing → balance + eventos; GET /v1/pricing público", async () => {
    const { app, ledger } = setup();
    const { mgmtToken, accountId } = (await (
      await app.request("/v1/accounts", { method: "POST" })
    ).json()) as { mgmtToken: string; accountId: string };
    await ledger.credit(accountId, 10_000_000n, "txA");
    await ledger.debit(accountId, 800_000n, "job-1");

    const bill = await app.request("/v1/me/billing", { headers: { authorization: `Bearer ${mgmtToken}` } });
    assert.equal(bill.status, 200);
    const j = (await bill.json()) as { balanceStroops: string; events: { kind: string; ref: string }[] };
    assert.equal(j.balanceStroops, "9200000");
    assert.equal(j.events.length, 2);

    const pricing = await app.request("/v1/pricing");
    assert.equal(pricing.status, 200);
    const p = (await pricing.json()) as { models: Record<string, { prompt: string }> };
    assert.equal(p.models["qwen3:4b"]!.prompt, "1000000");
  });
});
