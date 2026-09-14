// S10a — keyauth en gateway: key válida abre, trucha 401, ausente sigue al paywall.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.ts";
import { InMemoryApiKeys } from "@weaver/api-keys";
import { FakeVerifier } from "@weaver/settlement";

const forges = () => [
  { forgeId: "f", model: "qwen3:4b", hot: true, rttMs: 1, queueMs: 0, loadTimeMs: 0, price: 0, reliability: 1 },
];
const jobsInit = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "qwen3:4b" }) } as const;

describe("S10a keyauth", () => {
  it("Bearer válido → 200 aunque haya paywall sin x-payment", async () => {
    const keys = new InMemoryApiKeys();
    const { secret } = await keys.issue("dev");
    const app = createApp({ forges, apiKeys: keys, paywall: { verifier: new FakeVerifier(), payTo: "G" } });
    const res = await app.request("/v1/jobs", {
      ...jobsInit,
      headers: { ...jobsInit.headers, authorization: `Bearer ${secret}` },
    });
    assert.equal(res.status, 200);
  });

  it("Bearer trucho → 401, no 402", async () => {
    const keys = new InMemoryApiKeys();
    const app = createApp({ forges, apiKeys: keys, paywall: { verifier: new FakeVerifier(), payTo: "G" } });
    const res = await app.request("/v1/jobs", {
      ...jobsInit,
      headers: { ...jobsInit.headers, authorization: "Bearer wvr_trucha" },
    });
    assert.equal(res.status, 401);
  });

  it("sin header → cae al paywall (402)", async () => {
    const keys = new InMemoryApiKeys();
    const app = createApp({ forges, apiKeys: keys, paywall: { verifier: new FakeVerifier(), payTo: "G" } });
    const res = await app.request("/v1/jobs", jobsInit);
    assert.equal(res.status, 402);
  });
});

describe("S10a admin keys", () => {
  it("issue → {id, secret}; list sin secretos; revoke", async () => {
    const keys = new InMemoryApiKeys();
    const app = createApp({ forges, apiKeys: keys });
    const created = await app.request("/v1/admin/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ owner: "jurado" }),
    });
    assert.equal(created.status, 201);
    const { id, secret } = (await created.json()) as { id: string; secret: string };
    assert.ok(secret.startsWith("wvr_"));

    const listed = await app.request("/v1/admin/keys");
    assert.equal(listed.status, 200);
    const items = (await listed.json()) as { id: string }[];
    assert.ok(items.some((k) => k.id === id));

    const revoked = await app.request(`/v1/admin/keys/${id}/revoke`, { method: "POST" });
    assert.equal(revoked.status, 200);

    const gated = await app.request("/v1/jobs", {
      ...jobsInit,
      headers: { ...jobsInit.headers, authorization: `Bearer ${secret}` },
    });
    assert.equal(gated.status, 401);
  });

  it("sin apiKeys en Deps → admin keys 404", async () => {
    const app = createApp({ forges });
    const res = await app.request("/v1/admin/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 404);
  });
});
