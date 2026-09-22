// S4 — PaymentVerifier: fake local + adapter al facilitador managed.
// El adapter real habla HTTP al facilitador; con fetch inyectado no necesita red.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FakeVerifier, FacilitatorVerifier } from "../src/verifier.ts";
import { JOB_PRICE_USDC } from "../src/ports.ts";

const REQS = { scheme: "exact", network: "stellar:testnet", price: "$0.01", payTo: "GTESTPAYTO" } as const;

describe("S4 FakeVerifier", () => {
  it("acepta proof válido y rechaza trucho", async () => {
    const v = new FakeVerifier();
    assert.equal(await v.verify("valid-proof", REQS), true);
    assert.equal(await v.verify("trucho", REQS), false);
    assert.equal(await v.verify("", REQS), false);
  });

  it("S23: settle del proof válido devuelve txHash fake", async () => {
    const v = new FakeVerifier();
    assert.deepEqual(await v.settle("valid-proof", REQS), { success: true, txHash: "fake-client-tx" });
    assert.deepEqual(await v.settle("trucho", REQS), { success: false });
  });
});

describe("S4 FacilitatorVerifier", () => {
  it("POST a /verify y mapea isValid:true → true", async () => {
    const seen: { url?: string; body?: Record<string, unknown> } = {};
    const fetchFn = async (url: string, init: RequestInit): Promise<Response> => {
      seen.url = url;
      seen.body = JSON.parse(init.body as string) as Record<string, unknown>;
      return new Response(JSON.stringify({ isValid: true }), { status: 200 });
    };
    const v = new FacilitatorVerifier("https://facilitador.test/x402", fetchFn);
    assert.equal(await v.verify("cGF5bG9YWQ==", REQS), true);
    assert.equal(seen.url, "https://facilitador.test/x402/verify");
    assert.equal((seen.body?.["paymentRequirements"] as Record<string, unknown>)?.["network"], "stellar:testnet");
  });

  it("isValid:false o HTTP 500 → false, jamás throw", async () => {
    const no = new FacilitatorVerifier("https://x", async () => new Response(JSON.stringify({ isValid: false }), { status: 200 }));
    assert.equal(await no.verify("h", REQS), false);
    const err = new FacilitatorVerifier("https://x", async () => new Response("boom", { status: 500 }));
    assert.equal(await err.verify("h", REQS), false);
  });

  it("S23: POST a /settle y mapea success+txHash; error → success:false", async () => {
    const seen: { url?: string } = {};
    const ok = new FacilitatorVerifier("https://facilitador.test/x402", async (url) => {
      seen.url = url;
      return new Response(JSON.stringify({ success: true, txHash: "abc123" }), { status: 200 });
    });
    assert.deepEqual(await ok.settle("h", REQS), { success: true, txHash: "abc123" });
    assert.equal(seen.url, "https://facilitador.test/x402/settle");

    const down = new FacilitatorVerifier("https://x", async () => {
      throw new Error("facilitador caído");
    });
    assert.deepEqual(await down.settle("h", REQS), { success: false });
  });
});

describe("S4 precio único", () => {
  it("JOB_PRICE_USDC es $0.01 (fuente única de metering)", () => {
    assert.equal(JOB_PRICE_USDC, 0.01);
  });
});
