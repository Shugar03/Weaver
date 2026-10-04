// spec 012 — delegation session spend: template → firma EIP-712 → redeem
// acredita el cap al ledger (dlg:<hash>). Dedup, caveats y ownership.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.ts";
import { InMemoryApiKeys } from "@weaver/api-keys";
import {
  InMemoryAccountStore,
  InMemoryCreditLedger,
  InMemoryDelegationGrants,
  PricingBook,
} from "@weaver/accounts";
import { NonceStore } from "@weaver/forge-net";
import { dualVerify, evmForgeKeypair, ENFORCER_ERC20_TRANSFER_AMOUNT } from "@weaver/settlement";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

const AGENT = "0x1111111111111111111111111111111111111111";
const USDC = "0x534b2f3A21130d7a60830c2Df862319e593943A3";

const setup = () => {
  const accounts = new InMemoryAccountStore();
  const ledger = new InMemoryCreditLedger();
  const app = createApp({
    forges: () => [],
    apiKeys: new InMemoryApiKeys(),
    accounts,
    ledger,
    pricing: new PricingBook({ "qwen3:4b": { prompt: 1n, completion: 1n, image: 0n } }),
    meChallenges: new NonceStore(),
    verifyWalletSig: dualVerify,
    delegationGrants: new InMemoryDelegationGrants(),
    delegationAgent: AGENT,
    usdcToken: USDC,
    delegationChainId: 10143,
  });
  return { app, accounts, ledger };
};

// Cuenta con wallet EVM linkeada (login por firma — la wallet ES la cuenta).
const evmAccount = async (app: ReturnType<typeof createApp>) => {
  const kp = evmForgeKeypair();
  const ch = (await (await app.request("/v1/me/challenge", { method: "POST" })).json()) as { nonce: string };
  const sig = (await kp.sign(Buffer.from(`weaver-login:${ch.nonce}`))).toString("hex");
  const res = await app.request("/v1/me/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pubkey: kp.pubkey, nonce: ch.nonce, signature: sig }),
  });
  const { sessionToken } = (await res.json()) as { sessionToken: string };
  return { token: sessionToken, wallet: kp.pubkey, secret: kp.secret as `0x${string}` };
};

const signDelegation = async (secret: `0x${string}`, message: Record<string, unknown>) => {
  const acct = privateKeyToAccount(secret);
  return acct.signTypedData({
    domain: {
      name: "DelegationManager",
      version: "1",
      chainId: 10143,
      verifyingContract: "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3",
    },
    types: {
      Delegation: [
        { name: "delegate", type: "address" },
        { name: "delegator", type: "address" },
        { name: "authority", type: "bytes32" },
        { name: "caveats", type: "Caveat[]" },
        { name: "salt", type: "uint256" },
      ],
      Caveat: [
        { name: "enforcer", type: "address" },
        { name: "terms", type: "bytes" },
      ],
    },
    primaryType: "Delegation",
    message: message as never,
  });
};

const template = async (app: ReturnType<typeof createApp>, token: string, capUSDC = 5, ttlSec = 3600) => {
  const res = await app.request("/v1/me/delegations/template", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ capUSDC, ttlSec }),
  });
  return { res, body: (await res.json()) as Record<string, unknown> };
};

const redeem = (app: ReturnType<typeof createApp>, token: string, delegation: Record<string, unknown>) =>
  app.request("/v1/me/delegations", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ delegation }),
  });

describe("spec 012 — delegation session spend", () => {
  it("template → firma → redeem acredita cap×10 al ledger (dlg:<hash>)", async () => {
    const { app, ledger, accounts } = setup();
    const { token, wallet, secret } = await evmAccount(app);

    const { res: tRes, body: tBody } = await template(app, token, 5, 3600);
    assert.equal(tRes.status, 200);
    const message = tBody.message as Record<string, unknown>;
    assert.equal(tBody.primaryType, "Delegation");
    assert.equal((message.delegator as string).toLowerCase(), wallet.toLowerCase());
    assert.equal((message.delegate as string).toLowerCase(), AGENT.toLowerCase());

    const signature = await signDelegation(secret, message);
    const r = await redeem(app, token, { ...message, signature });
    assert.equal(r.status, 201);
    const j = (await r.json()) as { delegationHash: string; amountUSDC: number; credited: boolean };
    assert.equal(j.amountUSDC, 5);
    assert.equal(j.credited, true);

    const account = (await accounts.byWallet(wallet))!;
    const bal = await ledger.balance(account.id);
    assert.equal(bal, 50_000_000n); // $5 USDC 6dec → stroops 7dec (×10)

    const evts = await ledger.history(account.id);
    assert.equal(evts[0].ref, `dlg:${j.delegationHash}`);
  });

  it("GET /v1/me/delegations lista el grant", async () => {
    const { app } = setup();
    const { token, secret } = await evmAccount(app);
    const { body: tBody } = await template(app, token, 2, 3600);
    const signature = await signDelegation(secret, tBody.message as Record<string, unknown>);
    await redeem(app, token, { ...(tBody.message as Record<string, unknown>), signature });

    const res = await app.request("/v1/me/delegations", { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    const { delegations } = (await res.json()) as { delegations: { amountUSDC: number; status: string }[] };
    assert.equal(delegations.length, 1);
    assert.equal(delegations[0].amountUSDC, 2);
    assert.equal(delegations[0].status, "redeemed");
  });

  it("replay del mismo redeem → 409, sin doble crédito", async () => {
    const { app, ledger, accounts } = setup();
    const { token, wallet, secret } = await evmAccount(app);
    const { body: tBody } = await template(app, token, 5, 3600);
    const message = { ...(tBody.message as Record<string, unknown>) };
    const signature = await signDelegation(secret, message);
    const delegation = { ...message, signature };

    assert.equal((await redeem(app, token, delegation)).status, 201);
    const r2 = await redeem(app, token, delegation);
    assert.equal(r2.status, 409);
    const account = (await accounts.byWallet(wallet))!;
    assert.equal(await ledger.balance(account.id), 50_000_000n);
  });

  it("firma trucha → 401; delegator ajeno → 403; delegate ajeno → 422", async () => {
    const { app } = setup();
    const { token, secret } = await evmAccount(app);
    const { body: tBody } = await template(app, token, 5, 3600);
    const message = tBody.message as Record<string, unknown>;

    // firma de OTRA key → invalid_signature
    const badSig = await signDelegation(generatePrivateKey(), message);
    const r1 = await redeem(app, token, { ...message, signature: badSig });
    assert.equal(r1.status, 401);

    // delegator = otra address → 403 (firma válida de esa otra key)
    const other = privateKeyToAccount(generatePrivateKey());
    const d2 = { ...message, delegator: other.address };
    const sig2 = await other.signTypedData({
      domain: { name: "DelegationManager", version: "1", chainId: 10143, verifyingContract: "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3" },
      types: {
        Delegation: [
          { name: "delegate", type: "address" },
          { name: "delegator", type: "address" },
          { name: "authority", type: "bytes32" },
          { name: "caveats", type: "Caveat[]" },
          { name: "salt", type: "uint256" },
        ],
        Caveat: [
          { name: "enforcer", type: "address" },
          { name: "terms", type: "bytes" },
        ],
      },
      primaryType: "Delegation",
      message: d2 as never,
    });
    assert.equal((await redeem(app, token, { ...d2, signature: sig2 })).status, 403);

    // delegate ajeno → 422
    const d3 = { ...message, delegate: other.address };
    const sig3 = await signDelegation(secret, d3);
    assert.equal((await redeem(app, token, { ...d3, signature: sig3 })).status, 422);
  });

  it("sin cap ERC20 → 422 missing_transfer_cap; template sin wallet → 422", async () => {
    const { app } = setup();
    const { token, secret } = await evmAccount(app);
    const { body: tBody } = await template(app, token, 5, 3600);
    const message = tBody.message as { caveats: { enforcer: string }[] } & Record<string, unknown>;
    // quito el caveat de cap — la delegación sigue firmable pero la rechazamos
    const stripped = {
      ...message,
      caveats: message.caveats.filter((cv) => cv.enforcer.toLowerCase() !== ENFORCER_ERC20_TRANSFER_AMOUNT.toLowerCase()),
    };
    const signature = await signDelegation(secret, stripped);
    const r = await redeem(app, token, { ...stripped, signature });
    assert.equal(r.status, 422);
    const j = (await r.json()) as { code: string };
    assert.equal(j.code, "missing_transfer_cap");

    // cuenta sin wallet (mgmt token) → 422 no_evm_wallet
    const acct = await app.request("/v1/accounts", { method: "POST" });
    const { mgmtToken } = (await acct.json()) as { mgmtToken: string };
    const { res } = await template(app, mgmtToken, 5, 3600);
    assert.equal(res.status, 422);
  });

  it("cap/ttl fuera de rango → 422; sin auth → 401", async () => {
    const { app } = setup();
    const { token } = await evmAccount(app);
    assert.equal((await template(app, token, 0, 3600)).res.status, 422);
    assert.equal((await template(app, token, 5, 30)).res.status, 422);
    assert.equal((await template(app, token, 20_000, 3600)).res.status, 422);
    assert.equal(
      (
        await app.request("/v1/me/delegations", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
      401,
    );
  });
});
