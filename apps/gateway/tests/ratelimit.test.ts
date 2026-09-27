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

  it("XFF spoofeado no abre buckets nuevos", async () => {
    // Antes: cada x-forwarded-for distinto era un caller nuevo = bypass trivial.
    // Ahora la identidad es keyId o IP real del socket; XFF no cuenta.
    const app = createApp({ forges: () => [], rateLimit: { rpm: 2 } });
    for (const ip of ["1.1.1.1", "2.2.2.2", "3.3.3.3"]) {
      await app.request("/v1/forges", { headers: { "x-forwarded-for": ip } });
    }
    const limited = await app.request("/v1/forges", { headers: { "x-forwarded-for": "4.4.4.4" } });
    assert.equal(limited.status, 429);
  });

  it("clientIp (seam): IPs distintas tienen buckets distintos", async () => {
    const app = createApp({
      forges: () => [],
      rateLimit: { rpm: 1 },
      clientIp: (c) => c.req.header("x-test-ip") ?? null,
    });
    assert.equal((await app.request("/v1/forges", { headers: { "x-test-ip": "10.0.0.1" } })).status, 200);
    assert.equal((await app.request("/v1/forges", { headers: { "x-test-ip": "10.0.0.2" } })).status, 200);
    assert.equal((await app.request("/v1/forges", { headers: { "x-test-ip": "10.0.0.1" } })).status, 429);
  });
});
