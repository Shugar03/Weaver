// Monad Mera Passkeys — TDD test suite
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { verifyMessage } from "viem";
import {
  deriveMonadWallet,
  deriveMultipleRoleWallets,
  USER_ROLE_INDEX,
  AGENT_ROLE_INDEX,
  OPERATOR_ROLE_INDEX,
} from "../lib/passkey.ts";

describe("Monad Mera Passkeys (WebAuthn PRF → Monad EOA)", () => {
  const dummyPrfSeed = new Uint8Array([
    0xaa, 0xbb, 0xcc, 0xdd, 0x01, 0x02, 0x03, 0x04,
    0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70, 0x80,
    0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88,
    0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00,
  ]);

  it("deriva Monad EOA determinista a partir de seed PRF", async () => {
    const w1 = deriveMonadWallet(dummyPrfSeed, USER_ROLE_INDEX);
    assert.match(w1.address, /^0x[0-9a-fA-F]{40}$/);
    assert.match(w1.privateKey, /^0x[0-9a-fA-F]{64}$/);
    assert.equal(w1.role, "user");

    // Misma semilla e índice → misma dirección exacta
    const w2 = deriveMonadWallet(dummyPrfSeed, USER_ROLE_INDEX);
    assert.equal(w1.address, w2.address);
    assert.equal(w1.privateKey, w2.privateKey);
  });

  it("'One Passkey, Many Keys': deriva múltiples identidades aisladas con roles diferenciados", async () => {
    const roles = deriveMultipleRoleWallets(dummyPrfSeed);

    assert.equal(roles.user.role, "user");
    assert.equal(roles.agent.role, "agent");
    assert.equal(roles.operator.role, "operator");

    // Las direcciones son distintas y no colisionan
    assert.notEqual(roles.user.address, roles.agent.address);
    assert.notEqual(roles.user.address, roles.operator.address);
    assert.notEqual(roles.agent.address, roles.operator.address);

    // Los private keys son independientes
    assert.notEqual(roles.user.privateKey, roles.agent.privateKey);
  });

  it("firma de challenge weaver-login verifica contra la address derivada", async () => {
    const wallet = deriveMonadWallet(dummyPrfSeed, USER_ROLE_INDEX);
    const nonce = "nonce_1234567890abcdef";
    const msg = `weaver-login:${nonce}`;

    const sigHex = await wallet.signMessage(msg);
    assert.match(sigHex, /^0x[0-9a-fA-F]{130}$/);

    const valid = await verifyMessage({
      address: wallet.address,
      message: msg,
      signature: sigHex,
    });
    assert.equal(valid, true);

    // Mensaje manipulado no verifica
    const invalid = await verifyMessage({
      address: wallet.address,
      message: "weaver-login:nonce_alterado",
      signature: sigHex,
    });
    assert.equal(invalid, false);
  });

  it("rechaza seeds con entropía insuficiente (< 32 bytes)", () => {
    const shortSeed = new Uint8Array([1, 2, 3]);
    assert.throws(
      () => deriveMonadWallet(shortSeed, 0),
      /al menos 32 bytes de entropía/
    );
  });
});
