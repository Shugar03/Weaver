// Module Settlement — PaymentVerifier: puerto de verificación x402 v2.
// Producción: FacilitatorVerifier contra facilitador managed (OpenZeppelin testnet).
// Tests/demo sin fondos: FakeVerifier. verify jamás throwea: un facilitador
// caído no puede voltear el gateway, solo cierra la puerta (false).
export type PaymentRequirements = {
  scheme: "exact";
  // Stellar clásico o CAIP-2 EVM ("eip155:<chainId>" — Monad = eip155:10143).
  network: "stellar:testnet" | `eip155:${number}`;
  price?: string; // display "$0.01" — los facilitadores EVM usan amount/asset
  payTo: string;
  // — x402 v2 canónico (facilitadores EVM exigen este shape) —
  asset?: string; // token EIP-3009 (USDC en Monad)
  amount?: string; // atomic units
  resource?: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>; // EIP-712 domain: {name:"USDC",version:"2"}
};

// S23: settle = ejecutar el pago on-chain vía el facilitador (post-serve).
export type SettleResult = { success: boolean; txHash?: string };

export interface PaymentVerifier {
  verify(paymentHeader: string, req: PaymentRequirements): Promise<boolean>;
  settle(paymentHeader: string, req: PaymentRequirements): Promise<SettleResult>;
}

export class FakeVerifier implements PaymentVerifier {
  async verify(paymentHeader: string, _req: PaymentRequirements): Promise<boolean> {
    return paymentHeader === "valid-proof";
  }
  async settle(paymentHeader: string, _req: PaymentRequirements): Promise<SettleResult> {
    return paymentHeader === "valid-proof" ? { success: true, txHash: "fake-client-tx" } : { success: false };
  }
}

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export class FacilitatorVerifier implements PaymentVerifier {
  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;

  constructor(baseUrl = "https://channels.openzeppelin.com/x402/testnet", fetchFn?: FetchFn) {
    this.baseUrl = baseUrl;
    this.fetchFn = fetchFn ?? ((url, init) => fetch(url, init));
  }

  async verify(paymentHeader: string, req: PaymentRequirements): Promise<boolean> {
    try {
      const res = await this.fetchFn(`${this.baseUrl.replace(/\/$/, "")}/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ x402Version: 2, paymentHeader, paymentRequirements: req }),
      });
      if (!res.ok) return false;
      const json = (await res.json()) as { isValid?: boolean };
      return json.isValid === true;
    } catch {
      return false;
    }
  }

  // S23: verify autoriza, settle ejecuta. Post-serve: si el forge falló no se
  // cobra; facilitador caído → success:false, jamás throw (misma regla que verify).
  async settle(paymentHeader: string, req: PaymentRequirements): Promise<SettleResult> {
    try {
      const res = await this.fetchFn(`${this.baseUrl.replace(/\/$/, "")}/settle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ x402Version: 2, paymentHeader, paymentRequirements: req }),
      });
      if (!res.ok) return { success: false };
      const json = (await res.json()) as { success?: boolean; txHash?: string };
      return json.success === true ? { success: true, txHash: json.txHash } : { success: false };
    } catch {
      return { success: false };
    }
  }
}

// — ADR-0008: facilitador x402 v2 canónico (Monad) —
// Wire distinto del clásico: POST {x402Version:2, paymentPayload:<objeto
// decodificado>, paymentRequirements} — el X-PAYMENT header sigue siendo
// base64(JSON) pero viaja decodificado en el body. SettleResponse usa
// `transaction` (no txHash) y `payer`.
type X402V2PaymentPayload = {
  x402Version: number;
  accepted?: unknown;
  payload: Record<string, unknown>;
  resource?: unknown;
};

export class EvmFacilitatorVerifier implements PaymentVerifier {
  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;

  constructor(baseUrl = "https://x402-facilitator.molandak.org", fetchFn?: FetchFn) {
    this.baseUrl = baseUrl;
    this.fetchFn = fetchFn ?? ((url, init) => fetch(url, init));
  }

  private decode(header: string): X402V2PaymentPayload | null {
    try {
      const p = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as X402V2PaymentPayload;
      // payload:null cuela con typeof==="object" — un header así no viaja al
      // facilitador (verify false directo, no request desperdiciado).
      return typeof p === "object" && p !== null && typeof p.payload === "object" && p.payload !== null ? p : null;
    } catch {
      return null;
    }
  }

  private async call(path: string, header: string, req: PaymentRequirements): Promise<Record<string, unknown> | null> {
    const paymentPayload = this.decode(header);
    if (!paymentPayload) return null;
    try {
      const res = await this.fetchFn(`${this.baseUrl.replace(/\/$/, "")}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements: req }),
      });
      if (!res.ok) return null;
      return (await res.json()) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  async verify(paymentHeader: string, req: PaymentRequirements): Promise<boolean> {
    const json = await this.call("verify", paymentHeader, req);
    return json?.isValid === true;
  }

  async settle(paymentHeader: string, req: PaymentRequirements): Promise<SettleResult> {
    const json = await this.call("settle", paymentHeader, req);
    if (json?.success !== true) return { success: false };
    const txHash = (json.transaction ?? json.txHash) as string | undefined;
    return { success: true, ...(txHash ? { txHash } : {}) };
  }
}
