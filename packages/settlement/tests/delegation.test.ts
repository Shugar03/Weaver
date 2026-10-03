// MetaMask Delegation Toolkit (ERC-7710 / ERC-7715) — TDD suite
// Terms/addresses = Delegation Framework v1.3.0 canónico (mismas en todas las
// chains por CREATE2 — documents/Deployments.md). El engine espeja los
// enforcers on-chain: el gasto sale del calldata, no de request.value.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import {
  type Delegation,
  DelegationEngine,
  buildWeaverAgentDelegation,
  verifyDelegationSignature,
  hashDelegation,
  decodeErc20TransferAmountTerms,
  decodeTimestampTerms,
  DELEGATION_DOMAIN,
  DELEGATION_MANAGER,
  ENFORCER_ERC20_TRANSFER_AMOUNT,
  ENFORCER_ALLOWED_TARGETS,
  ENFORCER_TIMESTAMP,
  ENFORCER_LIMITED_CALLS,
} from "../src/delegation.ts";

const USDC = "0x534b2f3A21130d7a60830c2Df862319e593943A3";
const ESCROW_ADDR = "0x51acE4858652D942dC7b320870e4CDbc5c989cD6";
const ATTACKER_ADDR = "0x6666666666666666666666666666666666666666";

// transfer(address to, uint256 amount) — calldata de 68B como la ejecuta el agent.
const transferCalldata = (to: string, amount: bigint) =>
  `0xa9059cbb${to.toLowerCase().replace("0x", "").padStart(64, "0")}${amount.toString(16).padStart(64, "0")}`;

const base = {
  usdc: USDC,
  allowedTargets: [USDC],
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};

describe("MetaMask Delegation Toolkit (ERC-7710 / ERC-7715)", () => {
  it("direcciones y dominio = Delegation Framework v1.3.0 canónico", () => {
    // Regresión anti-placeholder: si alguien vuelve a poner 0x…0001 las
    // firmas dejarían de verificar contra el DelegationManager real.
    assert.equal(DELEGATION_MANAGER, "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3");
    assert.equal(ENFORCER_ERC20_TRANSFER_AMOUNT, "0xf100b0819427117EcF76Ed94B358B1A5b5C6D2Fc");
    assert.equal(ENFORCER_ALLOWED_TARGETS, "0x7F20f61b1f09b08D970938F6fa563634d65c4EeB");
    assert.equal(ENFORCER_TIMESTAMP, "0x1046bb45C8d673d4ea75321280DB34899413c069");
    assert.equal(ENFORCER_LIMITED_CALLS, "0x04658B29F6b82ed55274221a06Fc97D318E25416");
    const d = DELEGATION_DOMAIN(10143);
    assert.equal(d.name, "DelegationManager");
    assert.equal(d.verifyingContract, DELEGATION_MANAGER);
  });

  it("terms encodePacked como el contrato: 52B ERC20, 32B timestamp", () => {
    const user = privateKeyToAccount(generatePrivateKey());
    const agent = privateKeyToAccount(generatePrivateKey());
    const d = buildWeaverAgentDelegation({
      delegator: user.address,
      agent: agent.address,
      maxAmount: 5_000_000n,
      ...base,
    });
    const erc20 = d.caveats.find((c) => c.enforcer === ENFORCER_ERC20_TRANSFER_AMOUNT);
    assert.equal(erc20?.terms.length, 2 + 52 * 2);
    const { token, maxAmount } = decodeErc20TransferAmountTerms(erc20!.terms);
    assert.equal(token.toLowerCase(), USDC.toLowerCase());
    assert.equal(maxAmount, 5_000_000n);
    const ts = d.caveats.find((c) => c.enforcer === ENFORCER_TIMESTAMP);
    assert.equal(ts?.terms.length, 66);
    assert.equal(decodeTimestampTerms(ts!.terms).before, base.expiresAt);
  });

  it("firma EIP-712 válida verifica contra el dominio real; otra firma rechaza", async () => {
    const user = privateKeyToAccount(generatePrivateKey());
    const agent = privateKeyToAccount(generatePrivateKey());

    const delegation = buildWeaverAgentDelegation({
      delegator: user.address,
      agent: agent.address,
      maxAmount: 5_000_000n,
      ...base,
    });

    const domain = DELEGATION_DOMAIN(10143);
    const types = {
      Delegation: [
        { name: "delegate", type: "address" },
        { name: "delegator", type: "address" },
        { name: "authority", type: "bytes32" },
        { name: "caveats", type: "Caveat[]" },
        { name: "salt", type: "uint256" },
      ],
      Caveat: [
        { name: "enforcer", type: "address" },
        { name: "terms", type: "bytes" },
      ],
    } as const;
    const message = {
      delegate: delegation.delegate,
      delegator: delegation.delegator,
      authority: delegation.authority,
      caveats: delegation.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms })),
      salt: delegation.salt,
    };

    delegation.signature = await user.signTypedData({
      domain,
      types,
      primaryType: "Delegation",
      message,
    });
    assert.equal(await verifyDelegationSignature(delegation), true);

    const other = privateKeyToAccount(generatePrivateKey());
    const fakeSig = await other.signTypedData({ domain, types, primaryType: "Delegation", message });
    assert.equal(await verifyDelegationSignature({ ...delegation, signature: fakeSig }), false);
  });

  it("ERC20TransferAmount: acumula gasto del calldata y rechaza al superar el cap", async () => {
    const user = privateKeyToAccount(generatePrivateKey());
    const agent = privateKeyToAccount(generatePrivateKey());
    const engine = new DelegationEngine();

    const delegation = buildWeaverAgentDelegation({
      delegator: user.address,
      agent: agent.address,
      maxAmount: 20_000n, // $0.02 USDC — 2 transfers de $0.01
      ...base,
    });

    const r1 = await engine.validateAndExecute(delegation, {
      target: USDC,
      value: 0n,
      data: transferCalldata(agent.address, 10_000n),
    });
    assert.equal(r1.success, true);
    assert.equal(r1.remainingAllowance, 10_000n);

    const r2 = await engine.validateAndExecute(delegation, {
      target: USDC,
      value: 0n,
      data: transferCalldata(agent.address, 10_000n),
    });
    assert.equal(r2.success, true);
    assert.equal(r2.remainingAllowance, 0n);

    const r3 = await engine.validateAndExecute(delegation, {
      target: USDC,
      value: 0n,
      data: transferCalldata(agent.address, 1n),
    });
    assert.equal(r3.success, false);
    assert.equal(r3.error, "spending_limit_exceeded");
  });

  it("ERC20TransferAmount: exec que no es transfer() sobre el token → rechazo", async () => {
    const user = privateKeyToAccount(generatePrivateKey());
    const agent = privateKeyToAccount(generatePrivateKey());
    const engine = new DelegationEngine();
    const delegation = buildWeaverAgentDelegation({
      delegator: user.address,
      agent: agent.address,
      maxAmount: 20_000n,
      ...base,
    });
    // Target correcto pero selector approve, no transfer:
    const r = await engine.validateAndExecute(delegation, {
      target: USDC,
      value: 0n,
      data: `0x095ea7b3${"0".repeat(64)}${"0".repeat(63)}1`,
    });
    assert.equal(r.success, false);
    assert.equal(r.error, "not_a_token_transfer");
  });

  it("AllowedTargets: restringe ejecución a contratos autorizados", async () => {
    const user = privateKeyToAccount(generatePrivateKey());
    const agent = privateKeyToAccount(generatePrivateKey());
    const engine = new DelegationEngine();

    // Sin presupuesto ERC20: la delegación permite calls de contrato, no
    // solo transfers — semantic real: ERC20TransferAmount forzaría
    // selector=transfer en CADA exec.
    const delegation = buildWeaverAgentDelegation({
      delegator: user.address,
      agent: agent.address,
      ...base,
      allowedTargets: [USDC, ESCROW_ADDR],
    });

    const ok = await engine.validateAndExecute(delegation, {
      target: ESCROW_ADDR,
      value: 0n,
      data: "0xa3161c56" + "0".repeat(64),
    });
    assert.equal(ok.success, true);

    const blocked = await engine.validateAndExecute(delegation, {
      target: ATTACKER_ADDR,
      value: 0n,
      data: "0xa3161c56" + "0".repeat(64),
    });
    assert.equal(blocked.success, false);
    assert.equal(blocked.error, "target_not_allowed");
  });

  it("Timestamp: umbrales exclusivos — before vence, after aún no abre", async () => {
    const user = privateKeyToAccount(generatePrivateKey());
    const agent = privateKeyToAccount(generatePrivateKey());
    const engine = new DelegationEngine();
    const now = 1_700_000_000;

    const expired = buildWeaverAgentDelegation({
      delegator: user.address,
      agent: agent.address,
      usdc: USDC,
      maxAmount: 1_000_000n,
      allowedTargets: [USDC],
      validAfter: now - 3600,
      expiresAt: now - 60,
    });
    const rExpired = await engine.validateAndExecute(
      expired,
      { target: USDC, value: 0n, data: transferCalldata(agent.address, 10n) },
      { currentTimestamp: now }
    );
    assert.equal(rExpired.success, false);
    assert.equal(rExpired.error, "delegation_expired");

    const future = buildWeaverAgentDelegation({
      delegator: user.address,
      agent: agent.address,
      usdc: USDC,
      maxAmount: 1_000_000n,
      allowedTargets: [USDC],
      validAfter: now + 3600,
      expiresAt: now + 7200,
    });
    const rFuture = await engine.validateAndExecute(
      future,
      { target: USDC, value: 0n, data: transferCalldata(agent.address, 10n) },
      { currentTimestamp: now }
    );
    assert.equal(rFuture.success, false);
    assert.equal(rFuture.error, "delegation_not_yet_valid");
  });

  it("AllowedMethods: solo selectores autorizados", async () => {
    const user = privateKeyToAccount(generatePrivateKey());
    const agent = privateKeyToAccount(generatePrivateKey());
    const engine = new DelegationEngine();
    const FUND_JOB = "0xa3161c56";
    const DRAIN = "0xba5e0000";

    const delegation = buildWeaverAgentDelegation({
      delegator: user.address,
      agent: agent.address,
      ...base,
      allowedSelectors: [FUND_JOB],
    });

    const ok = await engine.validateAndExecute(delegation, {
      target: USDC,
      value: 0n,
      data: `${FUND_JOB}${"0".repeat(64)}`,
    });
    assert.equal(ok.success, true);

    const bad = await engine.validateAndExecute(delegation, {
      target: USDC,
      value: 0n,
      data: `${DRAIN}${"0".repeat(64)}`,
    });
    assert.equal(bad.success, false);
    assert.equal(bad.error, "method_not_allowed");
  });

  it("LimitedCalls: N ejecuciones y no una más", async () => {
    const user = privateKeyToAccount(generatePrivateKey());
    const agent = privateKeyToAccount(generatePrivateKey());
    const engine = new DelegationEngine();
    const delegation = buildWeaverAgentDelegation({
      delegator: user.address,
      agent: agent.address,
      maxAmount: 1_000_000n,
      maxCalls: 2n,
      ...base,
    });
    const exec = { target: USDC, value: 0n, data: transferCalldata(agent.address, 10n) };
    assert.equal((await engine.validateAndExecute(delegation, exec)).success, true);
    assert.equal((await engine.validateAndExecute(delegation, exec)).success, true);
    const r3 = await engine.validateAndExecute(delegation, exec);
    assert.equal(r3.success, false);
    assert.equal(r3.error, "calls_limit_exceeded");
  });

  it("hashDelegation produce bytes32 estable (EIP-712)", () => {
    const d: Delegation = buildWeaverAgentDelegation({
      delegator: "0x1111111111111111111111111111111111111111",
      agent: "0x2222222222222222222222222222222222222222",
      maxAmount: 1000n,
      salt: 42n,
      ...base,
    });
    const h = hashDelegation(d);
    assert.match(h, /^0x[0-9a-f]{64}$/);
    assert.equal(hashDelegation({ ...d, salt: 42n }), h);
  });
});
