// S4 — PaymentVerifier: fake local + adapter al facilitador managed.
// El adapter real habla HTTP al facilitador; con fetch inyectado no necesita red.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FakeVerifier, FacilitatorVerifier, EvmFacilitatorVerifier } from "../src/verifier.ts";
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

describe("ADR-0008 EvmFacilitatorVerifier (x402 v2 canónico)", () => {
  const EVM_REQS = {
    scheme: "exact",
    network: "eip155:10143",
    asset: "0x534b2f3A21130d7a60830c2Df862319e593943A3",
    amount: "10000",
    payTo: "0xbaD8908CD47c0A47F31F35a45e5c8Ba14878aF3B",
    maxTimeoutSeconds: 60,
    extra: { name: "USDC", version: "2" },
  } as const;
  const HEADER = Buffer.from(
    JSON.stringify({ x402Version: 2, accepted: {}, payload: { signature: "0xab" } }),
  ).toString("base64");

  it("decodifica el header base64 y POSTea paymentPayload como objeto", async () => {
    const seen: { url?: string; body?: Record<string, unknown> } = {};
    const fetchFn = async (url: string, init: RequestInit): Promise<Response> => {
      seen.url = url;
      seen.body = JSON.parse(init.body as string) as Record<string, unknown>;
      return new Response(JSON.stringify({ isValid: true }), { status: 200 });
    };
    const v = new EvmFacilitatorVerifier("https://facilitador.test", fetchFn);
    assert.equal(await v.verify(HEADER, EVM_REQS), true);
    assert.equal(seen.url, "https://facilitador.test/verify");
    const pp = seen.body?.["paymentPayload"] as Record<string, unknown>;
    assert.equal(typeof pp, "object");
    assert.equal((pp.payload as Record<string, unknown>).signature, "0xab");
    assert.equal((seen.body?.["paymentRequirements"] as Record<string, unknown>)?.["network"], "eip155:10143");
  });

  it("header no-decodificable → false sin llamar al facilitador", async () => {
    let calls = 0;
    const v = new EvmFacilitatorVerifier("https://x", async () => {
      calls++;
      return new Response("{}");
    });
    assert.equal(await v.verify("no-es-base64-json!!!", EVM_REQS), false);
    assert.equal(calls, 0);
  });

  it("payload malformado (null/string/array) → false sin tocar la red", async () => {
    let calls = 0;
    const v = new EvmFacilitatorVerifier("https://x", async () => {
      calls++;
      return new Response(JSON.stringify({ isValid: true }));
    });
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
    // Un facilitador que dijera "isValid:true" no importa — el header ni viaja.
    for (const bad of [
      { x402Version: 2, payload: null },
      { x402Version: 2, payload: "string" },
      { x402Version: 2, payload: 42 },
      { payload: { signature: "0x" } }, // sin x402Version — decode pasa, facilitator decide
    ]) {
      const ok = await v.verify(b64(bad), EVM_REQS);
      if ("x402Version" in bad) assert.equal(ok, false, JSON.stringify(bad));
      else assert.equal(ok, true); // shape incompleto lo evalúa el facilitador
    }
    assert.equal(calls, 1, "solo el payload con shape decente viaja");
  });

  it("facilitador 200 con body no-JSON → false sin throw", async () => {
    const v = new EvmFacilitatorVerifier("https://x", async () => new Response("<html>cloudflare</html>"));
    assert.equal(await v.verify(HEADER, EVM_REQS), false);
    assert.deepEqual(await v.settle(HEADER, EVM_REQS), { success: false });
  });

  it("facilitador HTTP 500/429 → verify false, settle success:false", async () => {
    for (const status of [500, 429, 401]) {
      const v = new EvmFacilitatorVerifier("https://x", async () => new Response("err", { status }));
      assert.equal(await v.verify(HEADER, EVM_REQS), false, `${status}`);
      assert.deepEqual(await v.settle(HEADER, EVM_REQS), { success: false }, `${status}`);
    }
  });

  it("settle mapea `transaction` (v2) y `txHash` (v1) indistintamente", async () => {
    const v2 = new EvmFacilitatorVerifier("https://x", async () =>
      new Response(JSON.stringify({ success: true, transaction: "0xtx" }), { status: 200 }),
    );
    assert.deepEqual(await v2.settle(HEADER, EVM_REQS), { success: true, txHash: "0xtx" });
    const down = new EvmFacilitatorVerifier("https://x", async () => {
      throw new Error("down");
    });
    assert.deepEqual(await down.settle(HEADER, EVM_REQS), { success: false });
  });
});

describe("S4 precio único", () => {
  it("JOB_PRICE_USDC es $0.01 (fuente única de metering)", () => {
    assert.equal(JOB_PRICE_USDC, 0.01);
  });
});
