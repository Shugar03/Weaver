// Module Settlement — adapter EVM (Monad, ADR-0008). Misma semántica que el
// escrow Soroban pero transporte viem: EvmSubmitter cumple el rol de
// ChainSubmitter (simula→firma→envía→espera receipt, serializado) y
// EvmEscrowSettlement repite el loop fund→release+journal.
// El proof L0 es personal_sign del forge sobre resultHash (32 bytes) — el forge
// firma al servir, sin conocer el jobId (idéntico al Soroban).
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  verifyMessage,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";
import { SerialQueue } from "./queue.ts";
import { payoutFor, type SettleReceipt } from "./escrow.ts";
import type { PendingSettle, SettleJournal } from "./journal.ts";

export const MONAD_TESTNET_CHAIN_ID = 10143;
/// USDC oficial de Circle en Monad testnet (6 dec)
export const MONAD_USDC = "0x534b2f3A21130d7a60830c2Df862319e593943A3" as Address;

// ABI mínima de WeaverEscrow (contracts/weaver-escrow-evm/src/WeaverEscrow.sol)
const ERC20_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export const ESCROW_ABI = [
  {
    type: "function",
    name: "registerForge",
    stateMutability: "nonpayable",
    inputs: [{ name: "signer", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "fundJob",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "worker", type: "address" },
    ],
    outputs: [{ name: "jobId", type: "uint256" }],
  },
  {
    type: "function",
    name: "release",
    stateMutability: "nonpayable",
    inputs: [
      { name: "jobId", type: "uint256" },
      { name: "resultHash", type: "bytes32" },
      { name: "forgeSig", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "refund",
    stateMutability: "nonpayable",
    inputs: [{ name: "jobId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "event",
    name: "Funded",
    inputs: [
      { name: "jobId", type: "uint256", indexed: true },
      { name: "client", type: "address", indexed: true },
      { name: "worker", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
] as const;

export type EvmSubmitterConfig = {
  rpcUrl: string;
  privateKey: Hex; // operador (admin): fondea y libera
  chainId?: number;
};

// Submit real EVM: writeContract → waitForReceipt → parsea el evento Funded
// para el jobId. La key jamás sale de acá. Serializado: dos txs concurrentes
// de la misma cuenta compiten por nonce (mismo problema que el seq de Stellar).
export class EvmSubmitter {
  private publicClient: PublicClient;
  private walletClient: ReturnType<typeof createWalletClient>;
  private account: ReturnType<typeof privateKeyToAccount>;
  private queue = new SerialQueue();
  readonly address: Address;

  constructor(cfg: EvmSubmitterConfig) {
    const chain = { ...monadTestnet, id: cfg.chainId ?? MONAD_TESTNET_CHAIN_ID };
    const transport = http(cfg.rpcUrl);
    this.publicClient = createPublicClient({ chain, transport });
    this.account = privateKeyToAccount(cfg.privateKey);
    this.walletClient = createWalletClient({ account: this.account, chain, transport });
    this.address = this.account.address;
  }

  invoke(contract: Address, abi: typeof ESCROW_ABI | typeof ERC20_ABI, fn: string, args: unknown[]): Promise<{
    txHash: Hex;
    retval?: bigint;
  }> {
    return this.queue.run(() => this.doInvoke(contract, abi, fn, args));
  }

  private async doInvoke(
    contract: Address,
    abi: typeof ESCROW_ABI | typeof ERC20_ABI,
    fn: string,
    args: unknown[],
  ): Promise<{ txHash: Hex; retval?: bigint }> {
    // simulate primero: captura el revert de la manera más barata posible y da
    // el returnValue (jobId del fundJob) sin mandar la tx.
    const { request, result } = await this.publicClient.simulateContract({
      address: contract,
      abi: abi as never,
      functionName: fn,
      args: args as never,
      account: this.account,
    });
    const txHash = await this.walletClient.writeContract(request as never);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      throw new Error(`tx ${fn} reverted: ${txHash}`);
    }
    return { txHash, retval: result as bigint | undefined };
  }

  /// approve idempotente: si ya alcanza, no gasta gas.
  async ensureAllowance(token: Address, spender: Address, amount: bigint): Promise<Hex | null> {
    const current = (await this.publicClient.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [this.address, spender],
    })) as bigint;
    if (current >= amount) return null;
    const { txHash } = await this.invoke(token, ERC20_ABI, "approve", [spender, amount]);
    return txHash;
  }
}

export type EvmEscrowConfig = {
  escrow: Address;
  token: Address; // USDC
  payout: number; // unidades base (6 dec) — mismo rango que Soroban
  perToken?: number;
};

// Loop fund→release con journal (I3: jamás huérfano) — mismo contrato de
// comportamiento que EscrowSettlement, args EVM (hex en vez de ScVal).
// Seam de transporte: en prod es EvmSubmitter (viem+RPC), en tests un fake.
// La settlement no sabe de RPC ni wallets — igual que el Soroban.
export type EvmEscrowTransport = Pick<EvmSubmitter, "invoke" | "ensureAllowance">;

export class EvmEscrowSettlement {
  private submitter: EvmEscrowTransport;
  private cfg: EvmEscrowConfig;
  private journal?: SettleJournal;
  private onPending?: (p: PendingSettle) => void;

  constructor(
    submitter: EvmEscrowTransport,
    cfg: EvmEscrowConfig,
    journal?: SettleJournal,
    onPending?: (p: PendingSettle) => void,
  ) {
    this.submitter = submitter;
    this.cfg = cfg;
    this.journal = journal;
    this.onPending = onPending;
    if (!Number.isInteger(cfg.payout) || cfg.payout <= 0) {
      throw new Error(`payout inválido: ${cfg.payout}`);
    }
  }

  // resultHash/forgeSig: mismo contrato que settleJob Soroban (Buffers de 32/65b;
  // la sig EVM es r‖s‖v = 65 bytes, el Soroban era 64 — la validación lo deja
  // explícito). workerAddr es la address EVM del forge (payout).
  async settleJob(
    resultHash: Buffer,
    forgeSig: Buffer,
    workerAddr: Address,
    stats?: { genTokens?: number },
  ): Promise<SettleReceipt> {
    if (resultHash.length !== 32) {
      throw new Error(`result_hash debe ser 32 bytes, vino ${resultHash.length}`);
    }
    if (forgeSig.length !== 65) {
      throw new Error(`forge_sig debe ser 65 bytes (r‖s‖v), vino ${forgeSig.length}`);
    }
    const payout = payoutFor(stats, { base: this.cfg.payout, perToken: this.cfg.perToken ?? 0 });
    await this.submitter.ensureAllowance(this.cfg.token, this.cfg.escrow, BigInt(payout));
    const funded = await this.submitter.invoke(this.cfg.escrow, ESCROW_ABI, "fundJob", [
      BigInt(payout),
      workerAddr,
    ]);
    const jobId = Number(funded.retval);
    await this.journal
      ?.record({
        jobId,
        worker: workerAddr,
        resultHash: resultHash.toString("hex"),
        forgeSig: forgeSig.toString("hex"),
        fundTx: funded.txHash,
        createdAt: Date.now(),
      })
      .catch((e) => console.warn(`settle journal record falló (job ${jobId}):`, e));
    try {
      const released = await this.submitter.invoke(this.cfg.escrow, ESCROW_ABI, "release", [
        BigInt(jobId),
        `0x${resultHash.toString("hex")}`,
        `0x${forgeSig.toString("hex")}`,
      ]);
      await this.journal?.markReleased(jobId, released.txHash).catch(() => {});
      return { jobId, fundTx: funded.txHash, releaseTx: released.txHash };
    } catch (e) {
      // Funded pero no released → pending: el sweep de boot lo retoma y
      // onPending notifica al forge (self-claim sin el operador).
      console.warn(`release falló post-fund (job ${jobId}, queda en journal):`, e);
      try {
        this.onPending?.({
          jobId,
          worker: workerAddr,
          resultHash: resultHash.toString("hex"),
          forgeSig: forgeSig.toString("hex"),
          fundTx: funded.txHash,
          createdAt: Date.now(),
        });
      } catch {}
      throw e;
    }
  }
}

// Errores terminal del contrato EVM (mismo set que el Soroban + los nuevos del
// port): revert con error conocido → no reintentar. Todo lo demás (timeout RPC,
// nonce, gas spike) es transitorio → el pending queda para el sweep de boot.
const EVM_TERMINAL = /BadState|Unauthorized|ForgeNotFound|BadAmount|JobNotFound|TooEarly|BadSignature|reverted with the following error/;
export function isTerminalEvmError(e: unknown): boolean {
  return EVM_TERMINAL.test(String(e));
}

// S44-equivalente EVM: sweep de pendings al boot. Mismo criterio terminal que
// el Soroban; el proof no expira.
export async function sweepPendingEvm(
  submitter: Pick<EvmSubmitter, "invoke">,
  journal: SettleJournal,
  escrow: Address,
): Promise<{ released: number; failed: number }> {
  const pend = await journal.pending();
  let released = 0;
  let failed = 0;
  for (const p of pend) {
    try {
      const r = await submitter.invoke(escrow, ESCROW_ABI, "release", [
        BigInt(p.jobId),
        `0x${p.resultHash}`,
        `0x${p.forgeSig}`,
      ]);
      await journal.markReleased(p.jobId, r.txHash);
      released++;
    } catch (e) {
      if (isTerminalEvmError(e)) {
        await journal.markFailed(p.jobId, String(e)).catch(() => {});
        failed++;
      } else {
        console.warn(`sweep EVM: release transitorio falló (job ${p.jobId}, sigue pending):`, e);
      }
    }
  }
  return { released, failed };
}

// registerForge on-chain — el WORKER manda la tx (msg.sender = worker, su
// payout) con la address del signer que firma sus proofs.
export async function registerForgeEvm(submitter: Pick<EvmSubmitter, "invoke">, escrow: Address, signer: Address): Promise<Hex> {
  const { txHash } = await submitter.invoke(escrow, ESCROW_ABI, "registerForge", [signer]);
  return txHash;
}

// — Forge-side crypto (el forge EVM usa secp256k1, no ed25519) —

// Signer del proof L0: firma personal_sign sobre los 32 bytes del resultHash.
// Devuelve r‖s‖v de 65 bytes — lo que verifica WeaverEscrow.release.
export function evmSigner(privateKey: Hex): (resultHash: Buffer) => Promise<Buffer> {
  const account = privateKeyToAccount(privateKey);
  return async (resultHash) => {
    const sig = await account.signMessage({ message: { raw: `0x${resultHash.toString("hex")}` as Hex } });
    return Buffer.from(sig.slice(2), "hex");
  };
}

// Verifica un proof contra la address registrada (gateway-side, sin RPC).
// Devuelve false ante input inválido — jamás throw por dato remoto.
export async function evmVerify(signer: Address, resultHash: Buffer, sig: Buffer): Promise<boolean> {
  try {
    return await verifyMessage({
      address: signer,
      message: { raw: `0x${resultHash.toString("hex")}` as Hex },
      signature: `0x${sig.toString("hex")}` as Hex,
    });
  } catch {
    return false;
  }
}

// Keypair de forge (secp256k1) — mismo rol que stellarKeypair() en el Soroban:
// devuelve la address (identidad) y el signer para el proof.
export function evmForgeKeypair(privateKey: Hex): { address: Address; sign(r: Buffer): Promise<Buffer> } {
  const account = privateKeyToAccount(privateKey);
  return { address: account.address, sign: evmSigner(privateKey) };
}

// keccak256 del resultado servido — el resultHash que ata pago a output.
export function evmResultHash(output: Buffer): Buffer {
  return Buffer.from(keccak256(`0x${output.toString("hex")}` as Hex).slice(2), "hex");
}
