// Module api-keys — identidad estilo provider (wvr_...), como OpenAI/Anthropic.
// Para qué: saber QUIÉN llama (metering, rate limits, allowlist). El cobro va por
// x402; la key identifica, no paga. El secreto se muestra UNA vez en issue y jamás
// se guarda en claro: solo SHA-256. Postgres reemplaza el Map post-hackathon.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export type KeyInfo = { id: string; owner: string };
export type KeyPublic = { id: string; owner: string; createdAt: number; revoked: boolean };

type KeyRecord = KeyPublic & { hash: string };

function sha(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

export interface ApiKeys {
  issue(owner: string): Promise<KeyInfo & { secret: string }>;
  verify(secret: string): Promise<KeyInfo | null>;
  revoke(id: string): Promise<boolean>;
  list(): Promise<KeyPublic[]>;
}

export class InMemoryApiKeys implements ApiKeys {
  private keys = new Map<string, KeyRecord>();
  private counter = 0;

  async issue(owner: string): Promise<KeyInfo & { secret: string }> {
    const id = `key_${Date.now().toString(36)}_${(this.counter++).toString(36)}`;
    const secret = `wvr_${randomBytes(24).toString("base64url")}`;
    this.keys.set(id, { id, owner, hash: sha(secret).toString("hex"), createdAt: Date.now(), revoked: false });
    return { id, secret };
  }

  async verify(secret: string): Promise<KeyInfo | null> {
    if (!secret.startsWith("wvr_")) return null;
    const probe = sha(secret);
    for (const k of this.keys.values()) {
      if (k.revoked) continue;
      const candidate = Buffer.from(k.hash, "hex");
      if (candidate.length === probe.length && timingSafeEqual(candidate, probe)) {
        return { id: k.id, owner: k.owner };
      }
    }
    return null;
  }

  async revoke(id: string): Promise<boolean> {
    const k = this.keys.get(id);
    if (!k || k.revoked) return false;
    k.revoked = true;
    return true;
  }

  async list(): Promise<KeyPublic[]> {
    return [...this.keys.values()].map(({ hash: _hash, ...pub }) => pub);
  }
}
