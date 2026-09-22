// S11 — admin solo operador: sin key → 401, key no-operador → 403, operador → 200.
// Sin apiKeys en Deps (dev local), admin sigue abierto: opt-in como el resto.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.ts";
import { InMemoryApiKeys } from "@weaver/api-keys";

const forges = () => [];
const chaos = { setDead: (_id: string | undefined, _dead: boolean) => true };
const json = { "content-type": "application/json" };

async function setup() {
  const keys = new InMemoryApiKeys();
  const op = await keys.issue("operator");
  const dev = await keys.issue("dev");
  return { keys, op, dev };
}

const kill = (secret?: string): RequestInit => ({
  method: "POST",
  headers: secret ? { ...json, authorization: `Bearer ${secret}` } : json,
  body: JSON.stringify({ dead: true }),
});

describe("S11 admin solo operador", () => {
  it("sin header → 401", async () => {
    const { keys } = await setup();
    const app = createApp({ forges, apiKeys: keys, chaos });
    assert.equal((await app.request("/v1/admin/kill", kill())).status, 401);
  });

  it("key no-operador → 403", async () => {
    const { keys, dev } = await setup();
    const app = createApp({ forges, apiKeys: keys, chaos });
    assert.equal((await app.request("/v1/admin/kill", kill(dev.secret))).status, 403);
  });

  it("operador → 200", async () => {
    const { keys, op } = await setup();
    const app = createApp({ forges, apiKeys: keys, chaos });
    const res = await app.request("/v1/admin/kill", kill(op.secret));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { dead: true });
  });

  it("emitir keys exige operador: dev → 403, operador → 201", async () => {
    const { keys, op, dev } = await setup();
    const app = createApp({ forges, apiKeys: keys });
    const issue = (secret?: string): RequestInit => ({
      method: "POST",
      headers: secret ? { ...json, authorization: `Bearer ${secret}` } : json,
      body: JSON.stringify({ owner: "x" }),
    });
    assert.equal((await app.request("/v1/admin/keys", issue(dev.secret))).status, 403);
    assert.equal((await app.request("/v1/admin/keys", issue(op.secret))).status, 201);
  });
});
