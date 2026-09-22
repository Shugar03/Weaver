// Module Settlement — PaymentVerifier: puerto de verificación x402 v2.
// Producción: FacilitatorVerifier contra facilitador managed (OpenZeppelin testnet).
// Tests/demo sin fondos: FakeVerifier. verify jamás throwea: un facilitador
// caído no puede voltear el gateway, solo cierra la puerta (false).
export type PaymentRequirements = {
  scheme: "exact";
  network: "stellar:testnet";
  price: string;
  payTo: string;
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
