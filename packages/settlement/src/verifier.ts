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

export interface PaymentVerifier {
  verify(paymentHeader: string, req: PaymentRequirements): Promise<boolean>;
}

export class FakeVerifier implements PaymentVerifier {
  async verify(paymentHeader: string, _req: PaymentRequirements): Promise<boolean> {
    return paymentHeader === "valid-proof";
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
}
