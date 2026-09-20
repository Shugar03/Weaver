// Module Settlement — Seam Stellar. x402 por request, escrow solo batch >$0.50.
// S4 (paywall) y S5 (escrow testnet) cruzan este Seam, no HTTP directo.
export const JOB_PRICE_USDC = 0.01; // S17a: fuente única del precio (quote + metering).
export type Quote = { amountUSDC: string; payTo: string; network: "stellar:testnet" };

export interface Settlement {
  quote(jobId: string): Quote; // $0.01 demo
  settle(executionId: string): Promise<{ txHash: string }>;
}

export class FakeSettlement implements Settlement {
  quote(_jobId: string): Quote {
    return { amountUSDC: JOB_PRICE_USDC.toFixed(2), payTo: "G...PAY_TO", network: "stellar:testnet" };
  }
  async settle(executionId: string): Promise<{ txHash: string }> {
    return { txHash: `fake-tx-${executionId}` };
  }
}
