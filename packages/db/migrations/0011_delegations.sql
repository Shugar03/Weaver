-- spec 012: grants de delegación MetaMask. hash = EIP-712 delegationHash —
-- PK + ref del topup (dlg:<hash>): el mismo grant jamás acredita dos veces.
-- delegation_json guarda la delegación firmada completa (audit trail).
CREATE TABLE IF NOT EXISTS delegations (
  hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  delegator TEXT NOT NULL,
  delegate TEXT NOT NULL,
  delegation_json TEXT NOT NULL,
  amount_stroops BIGINT NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS delegations_account_idx ON delegations (account_id);
