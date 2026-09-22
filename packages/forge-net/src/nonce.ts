// S32 — NonceStore: challenges de registro forge. Single-use + TTL:
// un nonce expirado o reusado no autentica (replay protection del handshake).
export class NonceStore {
  private readonly nonces = new Map<string, number>(); // nonce → expiresAt
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(now: () => number = Date.now, ttlMs = 60_000) {
    this.now = now;
    this.ttlMs = ttlMs;
  }

  issue(): { nonce: string; expiresAt: number } {
    const nonce = crypto.randomUUID();
    const expiresAt = this.now() + this.ttlMs;
    this.nonces.set(nonce, expiresAt);
    // Evicción perezosa anti-crecimiento (spam de challenges sin connect).
    if (this.nonces.size > 10_000) {
      const t = this.now();
      for (const [n, exp] of this.nonces) if (exp < t) this.nonces.delete(n);
    }
    return { nonce, expiresAt };
  }

  // Consume = verifica + borra: un nonce jamás autentica dos veces.
  consume(nonce: string): boolean {
    const exp = this.nonces.get(nonce);
    if (exp === undefined || exp < this.now()) return false;
    this.nonces.delete(nonce);
    return true;
  }
}
