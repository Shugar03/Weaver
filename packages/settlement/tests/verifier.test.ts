// S4 — PaymentVerifier: fake local + adapter al facilitador managed.
// El adapter real habla HTTP al facilitador; con fetch inyectado no necesita red.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FakeVerifier, FacilitatorVerifier } from "../src/verifier.ts";
import { FakeSettlement } from "../src/ports.ts";

const REQS = { scheme: "exact", network: "stellar:testnet", price: "$0.01", payTo: "GTESTPAYTO" } as const;

describe("S4 FakeVerifier", () => {
  it("acepta proof válido y rechaza trucho", async () => {
    const v = new FakeVerifier();
    assert.equal(await v.verify("valid-proof", REQS), true);
    assert.equal(await v.verify("trucho", REQS), false);
    assert.equal(await v.verify("", REQS), false);
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
});

describe("S4 quote", () => {
  it("cotiza $0.01 en stellar:testnet", () => {
    const q = new FakeSettlement().quote("j1");
    assert.equal(q.amountUSDC, "0.01");
    assert.equal(q.network, "stellar:testnet");
  });
});
