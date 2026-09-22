// Cliente /v1/me/* del panel de usuario (ADR-0007). Token en localStorage —
// la cuenta ES el token (wvr_acct_ o wvr_sess_); sin email/password.
export type MeInfo = {
  accountId: string;
  walletPubkey: string | null;
  balanceStroops: string;
  balanceUSDC: number;
  depositMemo: string;
  depositAddress: string | null;
  usage: { jobs: number; ok: number; okRate: number };
};

export type KeyPublic = { id: string; owner: string; createdAt: number; revoked: boolean };

export type LedgerEvent = {
  id: number;
  kind: "topup" | "debit";
  amount: string;
  amountUSDC: number;
  ref: string;
  createdAt: number;
};

const TOKEN_KEY = "weaver:account-token";

export function accountToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function saveAccountToken(t: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, t.trim());
  } catch {
    /* sin storage: la sesión vive en memoria del tab */
  }
}

export function clearAccountToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* noop */
  }
}

async function req<T>(base: string, path: string, token: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init?.body ? { "content-type": "application/json" } : {}) },
    cache: "no-store",
  });
  const j = (await r.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!r.ok) throw new AccountError(j.error ?? `http ${r.status}`, r.status, j.code);
  return j as T;
}

export class AccountError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

export async function createAccount(base: string): Promise<{ accountId: string; mgmtToken: string; depositMemo: string }> {
  const r = await fetch(`${base}/v1/accounts`, { method: "POST" });
  if (!r.ok) throw new AccountError("no se pudo crear la cuenta", r.status);
  return (await r.json()) as { accountId: string; mgmtToken: string; depositMemo: string };
}

export async function walletChallenge(base: string): Promise<{ nonce: string; expiresAt: number }> {
  const r = await fetch(`${base}/v1/me/challenge`, { method: "POST" });
  if (!r.ok) throw new AccountError("no se pudo pedir challenge", r.status);
  return (await r.json()) as { nonce: string; expiresAt: number };
}

export async function walletSession(
  base: string,
  pubkey: string,
  nonce: string,
  signature: string,
): Promise<{ sessionToken: string; accountId: string; expiresAt: number }> {
  const r = await fetch(`${base}/v1/me/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pubkey: pubkey.trim(), nonce, signature: signature.trim() }),
  });
  const j = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) throw new AccountError(j.error ?? `http ${r.status}`, r.status);
  return j as { sessionToken: string; accountId: string; expiresAt: number };
}

export const getMe = (base: string, t: string) => req<MeInfo>(base, "/v1/me", t);
export const listKeys = (base: string, t: string) => req<KeyPublic[]>(base, "/v1/me/keys", t);
export const createKey = (base: string, t: string) =>
  req<{ id: string; secret: string }>(base, "/v1/me/keys", t, { method: "POST" });
export const revokeKey = (base: string, t: string, id: string) =>
  req<{ revoked: boolean }>(base, `/v1/me/keys/${id}`, t, { method: "DELETE" });
export const getBilling = (base: string, t: string) =>
  req<{ balanceStroops: string; balanceUSDC: number; events: LedgerEvent[] }>(base, "/v1/me/billing", t);
