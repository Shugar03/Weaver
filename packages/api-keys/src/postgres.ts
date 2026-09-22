// Module api-keys — Postgres (ADR-0002). Mismo contrato que InMemory:
// el secreto jamás se guarda (solo SHA-256 hex); Postgres reemplaza al Map.
import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { apiKeys, type Db } from "@weaver/db";
import type { ApiKeys, KeyInfo, KeyPublic } from "./keys.ts";

function shaHex(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export class PostgresApiKeys implements ApiKeys {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  async issue(owner: string): Promise<KeyInfo & { secret: string }> {
    const secret = `wvr_${randomBytes(24).toString("base64url")}`;
    const info = await this.seed(owner, secret);
    return { ...info, secret };
  }

  async seed(owner: string, secret: string): Promise<KeyInfo> {
    const id = `key_${Date.now().toString(36)}_${Math.floor(Math.random() * 46656).toString(36)}`;
    await this.db.insert(apiKeys).values({ id, owner, hash: shaHex(secret) });
    return { id, owner };
  }

  async verify(secret: string): Promise<KeyInfo | null> {
    if (!secret.startsWith("wvr_")) return null;
    const rows = await this.db.select().from(apiKeys).where(eq(apiKeys.hash, shaHex(secret)));
    const k = rows[0];
    if (!k || k.revoked) return null;
    return { id: k.id, owner: k.owner };
  }

  async revoke(id: string): Promise<boolean> {
    const r = await this.db.update(apiKeys).set({ revoked: true }).where(eq(apiKeys.id, id)).returning();
    return r.length > 0;
  }

  async list(): Promise<KeyPublic[]> {
    const rows = await this.db.select().from(apiKeys);
    return rows.map((k) => ({
      id: k.id,
      owner: k.owner,
      createdAt: k.createdAt.getTime(),
      revoked: k.revoked,
    }));
  }

  async listByOwner(owner: string): Promise<KeyPublic[]> {
    const rows = await this.db.select().from(apiKeys).where(eq(apiKeys.owner, owner));
    return rows.map((k) => ({ id: k.id, owner: k.owner, createdAt: k.createdAt.getTime(), revoked: k.revoked }));
  }
}
