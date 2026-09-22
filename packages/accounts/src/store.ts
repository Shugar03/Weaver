// S47 (ADR-0007) — AccountStore: la cuenta del usuario final. Anónima por
// defecto: el management token (wvr_acct_) se muestra UNA vez al crear y se
// guarda solo su SHA-256 (A1). Wallet Stellar linkeable vía firma de nonce
// (mismo patrón que los forges): byWallet + linkWallet unifican identidad
// y pagos (deposit memo = pubkey).
// Sesiones wallet: wvr_sess_ efímeras (30d), hasheadas igual que todo secreto.
import { createHash, randomBytes } from "node:crypto";
import { accounts, accountSessions, type Db } from "@weaver/db";
import { eq, lt } from "drizzle-orm";

export type Account = {
  id: string;
  walletPubkey?: string;
  createdAt: number;
};

export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

function sha(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}
function token(prefix: string): string {
  return `${prefix}${randomBytes(24).toString("base64url")}`;
}
export function newAccountId(): string {
  return `acct_${Date.now().toString(36)}_${randomBytes(6).toString("base64url")}`;
}

export interface AccountStore {
  /** Crea cuenta anónima; devuelve el mgmt token en claro SOLO esta vez. */
  create(): Promise<{ account: Account; mgmtToken: string }>;
  /** Login por management token. */
  byMgmtToken(mgmtToken: string): Promise<Account | null>;
  /** Login por wallet ya linkeada. */
  byWallet(pubkey: string): Promise<Account | null>;
  /** Crea cuenta atada a una wallet (first-login por firma). */
  createForWallet(pubkey: string): Promise<Account>;
  /** Ata una wallet a una cuenta existente (firma ya verificada afuera). */
  linkWallet(accountId: string, pubkey: string): Promise<void>;
  /** Emite una sesión wvr_sess_ para la cuenta. */
  issueSession(accountId: string): Promise<{ token: string; expiresAt: number }>;
  /** Resuelve una sesión vigente. */
  bySession(sessionToken: string): Promise<Account | null>;
  get(id: string): Promise<Account | null>;
}

export class InMemoryAccountStore implements AccountStore {
  private readonly rows = new Map<string, Account & { mgmtHash?: string }>();
  private readonly sessions = new Map<string, { accountId: string; expiresAt: number }>();

  async create(): Promise<{ account: Account; mgmtToken: string }> {
    const mgmtToken = token("wvr_acct_");
    const account: Account = { id: newAccountId(), createdAt: Date.now() };
    this.rows.set(account.id, { ...account, mgmtHash: sha(mgmtToken) });
    return { account, mgmtToken };
  }

  async byMgmtToken(t: string): Promise<Account | null> {
    if (!t.startsWith("wvr_acct_")) return null;
    const h = sha(t);
    for (const r of this.rows.values()) if (r.mgmtHash === h) return { ...r };
    return null;
  }

  async byWallet(pubkey: string): Promise<Account | null> {
    for (const r of this.rows.values()) if (r.walletPubkey === pubkey) return { ...r };
    return null;
  }

  async createForWallet(pubkey: string): Promise<Account> {
    const account: Account = { id: newAccountId(), walletPubkey: pubkey, createdAt: Date.now() };
    this.rows.set(account.id, { ...account });
    return account;
  }

  async linkWallet(accountId: string, pubkey: string): Promise<void> {
    const r = this.rows.get(accountId);
    if (r) this.rows.set(accountId, { ...r, walletPubkey: pubkey });
  }

  async issueSession(accountId: string): Promise<{ token: string; expiresAt: number }> {
    const t = token("wvr_sess_");
    const expiresAt = Date.now() + SESSION_TTL_MS;
    this.sessions.set(sha(t), { accountId, expiresAt });
    return { token: t, expiresAt };
  }

  async bySession(t: string): Promise<Account | null> {
    if (!t.startsWith("wvr_sess_")) return null;
    const s = this.sessions.get(sha(t));
    if (!s || s.expiresAt < Date.now()) return null;
    const r = this.rows.get(s.accountId);
    return r ? { ...r } : null;
  }

  async get(id: string): Promise<Account | null> {
    const r = this.rows.get(id);
    return r ? { ...r } : null;
  }
}

export class PostgresAccountStore implements AccountStore {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  async create(): Promise<{ account: Account; mgmtToken: string }> {
    const mgmtToken = token("wvr_acct_");
    const id = newAccountId();
    await this.db.insert(accounts).values({ id, mgmtTokenHash: sha(mgmtToken) });
    return { account: { id, createdAt: Date.now() }, mgmtToken };
  }

  async byMgmtToken(t: string): Promise<Account | null> {
    if (!t.startsWith("wvr_acct_")) return null;
    const rows = await this.db.select().from(accounts).where(eq(accounts.mgmtTokenHash, sha(t))).limit(1);
    return rows[0] ? { id: rows[0].id, walletPubkey: rows[0].walletPubkey ?? undefined, createdAt: rows[0].createdAt.getTime() } : null;
  }

  async byWallet(pubkey: string): Promise<Account | null> {
    const rows = await this.db.select().from(accounts).where(eq(accounts.walletPubkey, pubkey)).limit(1);
    const r = rows[0];
    return r ? { id: r.id, walletPubkey: r.walletPubkey ?? undefined, createdAt: r.createdAt.getTime() } : null;
  }

  async createForWallet(pubkey: string): Promise<Account> {
    const id = newAccountId();
    await this.db.insert(accounts).values({ id, walletPubkey: pubkey });
    return { id, walletPubkey: pubkey, createdAt: Date.now() };
  }

  async linkWallet(accountId: string, pubkey: string): Promise<void> {
    await this.db.update(accounts).set({ walletPubkey: pubkey }).where(eq(accounts.id, accountId));
  }

  async issueSession(accountId: string): Promise<{ token: string; expiresAt: number }> {
    const t = token("wvr_sess_");
    const expiresAt = Date.now() + SESSION_TTL_MS;
    await this.db.delete(accountSessions).where(lt(accountSessions.expiresAt, new Date())); // GC barato por emisión
    await this.db.insert(accountSessions).values({ tokenHash: sha(t), accountId, expiresAt: new Date(expiresAt) });
    return { token: t, expiresAt };
  }

  async bySession(t: string): Promise<Account | null> {
    if (!t.startsWith("wvr_sess_")) return null;
    const rows = await this.db.select().from(accountSessions).where(eq(accountSessions.tokenHash, sha(t))).limit(1);
    const s = rows[0];
    if (!s || s.expiresAt.getTime() < Date.now()) return null;
    return this.get(s.accountId);
  }

  async get(id: string): Promise<Account | null> {
    const rows = await this.db.select().from(accounts).where(eq(accounts.id, id)).limit(1);
    const r = rows[0];
    return r ? { id: r.id, walletPubkey: r.walletPubkey ?? undefined, createdAt: r.createdAt.getTime() } : null;
  }
}
