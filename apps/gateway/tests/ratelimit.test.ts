// S15a — rate limit por caller (keyId o IP): ráfaga corta sí, abuso no.
// Sin Deps.rateLimit → abierto (dev). Con rpm → 429 con código, jamás 500.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.ts";

describe("S15a rate limit", () => {
  it("rpm=2: las primeras 2 pasan, la 3ra es 429", async () => {
    const app = createApp({ forges: () => [], rateLimit: { rpm: 2 } });
    assert.equal((await app.request("/v1/forges")).status, 200);
    assert.equal((await app.request("/v1/forges")).status, 200);
    const limited = await app.request("/v1/forges");
    assert.equal(limited.status, 429);
    const body = (await limited.json()) as { code: string };
    assert.equal(body.code, "rate_limited");
  });

  it("sin rateLimit en Deps → abierto", async () => {
    const app = createApp({ forges: () => [] });
    for (let i = 0; i < 5; i++) {
      assert.equal((await app.request("/v1/forges")).status, 200);
    }
  });

  it("el admin también está limitado (sin coronas)", async () => {
    const app = createApp({ forges: () => [], rateLimit: { rpm: 1 } });
    assert.equal((await app.request("/v1/status")).status, 200);
    assert.equal((await app.request("/v1/status")).status, 429);
  });
});
