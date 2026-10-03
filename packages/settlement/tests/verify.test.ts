// dualVerify: la pubkey decide el esquema y todo lo desconocido es fail-closed.
// Fleet mixta real: secp256k1 y ed25519 verifican cada una su firma, cruzadas
// jamás — y una pubkey malformada no puede "pasar" por ambigüedad.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dualVerify, isEvmAddr, verifyScheme } from "../src/verify.ts";
import { evmForgeKeypair } from "../src/evm.ts";
import { stellarKeypair, stellarSigner } from "../src/escrow.ts";
import type { Hex } from "viem";

const EVM_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const stellar = stellarKeypair();
const evm = evmForgeKeypair(EVM_PK);
const MSG = Buffer.alloc(32, 0xab);

describe("verifyScheme / isEvmAddr", () => {
  it("0x + 40 hex → evm (case-insensitive)", () => {
    assert.equal(verifyScheme(evm.address), "evm");
    assert.equal(verifyScheme(evm.address.toLowerCase()), "evm");
    assert.equal(verifyScheme("0x0000000000000000000000000000000000000000"), "evm");
  });
  it("G + 55 base32 → stellar", () => {
    assert.equal(verifyScheme(stellar.pubkey), "stellar");
  });
  it("basura → null (fail-closed por ambigüedad)", () => {
    for (const pk of ["", "0x", "0xZZZ", "G", "g" + "A".repeat(55), "0x1234", "H" + "A".repeat(55), "  0x" + "a".repeat(40)]) {
      assert.equal(verifyScheme(pk), null, pk);
    }
  });
  it("isEvmAddr matchea el mismo criterio que verifyScheme=evm", () => {
    assert.equal(isEvmAddr(evm.address), true);
    assert.equal(isEvmAddr(stellar.pubkey), false);
    assert.equal(isEvmAddr("0xGG"), false);
  });
});

describe("dualVerify — fleet mixta con crypto real", () => {
  it("evm: firma propia verifica; de otro signer no", async () => {
    const sig = await evm.sign(MSG);
    assert.equal(await dualVerify(evm.address, MSG, sig), true);
    const other = evmForgeKeypair("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e87293ed2b02a" as Hex);
    assert.equal(await dualVerify(evm.address, MSG, await other.sign(MSG)), false);
  });
  it("stellar: firma propia verifica; de otro signer no", () => {
    const sig = stellarSigner(stellar.secret)(MSG);
    assert.equal(dualVerify(stellar.pubkey, MSG, sig), true);
    const other = stellarKeypair();
    assert.equal(dualVerify(stellar.pubkey, MSG, stellarSigner(other.secret)(MSG)), false);
  });
  it("firma válida sobre OTRO mensaje → false (proof de otro job)", async () => {
    const otherMsg = Buffer.alloc(32, 0xcd);
    assert.equal(await dualVerify(evm.address, MSG, await evm.sign(otherMsg)), false);
    assert.equal(dualVerify(stellar.pubkey, MSG, stellarSigner(stellar.secret)(otherMsg)), false);
  });
  it("sig de tamaño equivocado → false (64b para evm, 65b para stellar)", async () => {
    const sig65 = await evm.sign(MSG);
    const sig64 = stellarSigner(stellar.secret)(MSG);
    assert.equal(sig65.length, 65);
    assert.equal(sig64.length, 64);
    assert.equal(await dualVerify(evm.address, MSG, sig64), false);
    assert.equal(dualVerify(stellar.pubkey, MSG, sig65), false);
  });
  it("pubkey desconocida → false sin throw", async () => {
    const sig = await evm.sign(MSG);
    assert.equal(await dualVerify("0xZZZ", MSG, sig), false);
    assert.equal(await dualVerify("", MSG, sig), false);
  });
});
