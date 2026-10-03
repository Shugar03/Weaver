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
  stringToHex,
  verifyMessage,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";
import { SerialQueue } from "./queue.ts";
import { payoutFor, type SettleReceipt } from "./escrow.ts";
import type { IntentJournal, PendingSettle, SettleJournal } from "./journal.ts";

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
    type: "function",
    name: "getJob",
    stateMutability: "view",
    inputs: [{ name: "jobId", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "client", type: "address" },
          { name: "worker", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "state", type: "uint8" },
          { name: "fundedAt", type: "uint64" },
          { name: "resultHash", type: "bytes32" },
        ],
      },
    ],
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

// topic0 Funded(uint256,address,address,uint256) — para eth_getLogs directo.
export const FUNDED_TOPIC = keccak256(stringToHex("Funded(uint256,address,address,uint256)"));

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

  invoke(contract: Address, abi: readonly unknown[], fn: string, args: unknown[]): Promise<{
    txHash: Hex;
    retval?: bigint;
  }> {
    return this.queue.run(() => this.doInvoke(contract, abi, fn, args));
  }

  private async doInvoke(
    contract: Address,
    abi: readonly unknown[],
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
  private journal?: IntentJournal;
  private onPending?: (p: PendingSettle) => void;

  constructor(
    submitter: EvmEscrowTransport,
    cfg: EvmEscrowConfig,
    journal?: IntentJournal,
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
  //
  // Intent-first (S50): el proof se persiste ANTES de fondear. Si el journal
  // falla → throw → nada on-chain sin proof durable. Un crash entre fund y
  // attach deja 'intent'+Funded → reconcileEvmOrphans los cierra.
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
    const jobKey = keccak256(`0x${forgeSig.toString("hex")}` as Hex);
    await this.journal?.recordIntent({
      jobKey,
      worker: workerAddr,
      resultHash: resultHash.toString("hex"),
      forgeSig: forgeSig.toString("hex"),
      createdAt: Date.now(),
    });
    const payout = payoutFor(stats, { base: this.cfg.payout, perToken: this.cfg.perToken ?? 0 });
    await this.submitter.ensureAllowance(this.cfg.token, this.cfg.escrow, BigInt(payout));
    const funded = await this.submitter.invoke(this.cfg.escrow, ESCROW_ABI, "fundJob", [
      BigInt(payout),
      workerAddr,
    ]);
    const jobId = Number(funded.retval);
    await this.journal
      ?.attachJob(jobKey, jobId, funded.txHash)
      .catch((e) => console.warn(`settle journal attach falló (job ${jobId}, el reconciler lo retoma):`, e));
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

// — S50: reconciler de escrows huérfanos —
// Cierra la última ventana de crash: fundJob minó pero attachJob no escribió
// (o el journal perdió la fila). El proof sigue como 'intent' sin jobId;
// on-chain existe un Funded sin liberar.
// Match por worker: el contrato solo exige ecrecover(resultHash,sig)==
// worker.signer en release — cualquier proof válido del worker libera el
// escrow, así que emparejar intent↔Funded por worker es exacto.
// Huérfanos sin intent (journal perdió TODO): no se puede liberar — el
// refund del operador a las 24h los recupera; se reportan ruidosamente.
export type FundedJob = { jobId: number; worker: Address; txHash: string };
export type ReconcileEvmDeps = {
  submitter: Pick<EvmSubmitter, "invoke">;
  journal: IntentJournal;
  escrow: Address;
  // Funded events del escrow con client=operator (eth_getLogs paginado en
  // serve.ts; array en tests). worker opcional filtra por topic indexado.
  fetchFunded: (worker?: Address) => Promise<FundedJob[]>;
  // getJob(jobId) → {state(0=Funded), worker} — null si no existe.
  readJob: (jobId: number) => Promise<{ state: number; worker: Address } | null>;
};
export async function reconcileEvmOrphans(deps: {
  submitter: Pick<EvmSubmitter, "invoke">;
  journal: IntentJournal;
  escrow: Address;
  fetchFunded: (worker?: Address) => Promise<FundedJob[]>;
  readJob: (jobId: number) => Promise<{ state: number; worker: Address } | null>;
}): Promise<{ recovered: number; orphans: number; staleIntents: number }> {
  const { submitter, journal, escrow, fetchFunded, readJob } = deps;
  const known = new Set(await journal.knownJobIds());
  let recovered = 0;
  let staleIntents = 0;

  // Fase 1: intents sin jobId → ¿hay un Funded on-chain del mismo worker que
  // el journal no conoce? attach + release con el proof del intent.
  // fetchFunded PROPAGA errores: un scan caído no es "sin eventos" — descartar
  // un intent con Funded real por un blip de RPC convierte plata recuperable
  // en huérfano permanente (el fallo reintenta el ciclo completo).
  for (const intent of await journal.intentsWithoutJob()) {
    const candidates = await fetchFunded(intent.worker as Address);
    let matched = false;
    let hadUnknown = false;
    for (const c of candidates) {
      if (known.has(c.jobId)) continue;
      const job = await readJob(c.jobId).catch(() => null);
      if (job === null) {
        hadUnknown = true; // job ilegible ≠ inexistente — no descartar el intent
        continue;
      }
      if (job.state !== 0 || job.worker.toLowerCase() !== intent.worker.toLowerCase()) continue;
      try {
        const released = await submitter.invoke(escrow, ESCROW_ABI, "release", [
          BigInt(c.jobId),
          `0x${intent.resultHash}`,
          `0x${intent.forgeSig}`,
        ]);
        await journal.attachJob(intent.jobKey, c.jobId, c.txHash).catch(() => {});
        await journal.markReleased(c.jobId, released.txHash).catch(() => {});
        known.add(c.jobId);
        recovered++;
        matched = true;
        console.log(`settle reconcile: intent ${intent.jobKey.slice(0, 12)}… → job ${c.jobId} released (${released.txHash})`);
        break;
      } catch (e) {
        if (isTerminalEvmError(e)) {
          // La sig no valida para ESTE job (edge: reorg/registro distinto) —
          // el intent no sirve acá; sigue al próximo candidato.
          continue;
        }
        console.warn(`settle reconcile: release transitorio falló (job ${c.jobId}):`, e);
        matched = true; // transitorio: reintenta en el próximo ciclo
        break;
      }
    }
    if (!matched && !hadUnknown) {
      staleIntents++;
      // El proof existe pero no hay Funded on-chain → fundJob nunca minó
      // (receipt perdido incluye el caso tx-droppeado). No se auto-fondea:
      // pagar trabajo ya entregado a destiempo es decisión del operador.
      // discard cierra el intent (audit trail, deja de re-advertir).
      await journal.discardIntent(intent.jobKey, "sin Funded on-chain").catch(() => {});
      console.warn(
        `settle reconcile: intent ${intent.jobKey.slice(0, 12)}… sin Funded on-chain (worker ${intent.worker.slice(0, 10)}…) → descartado. Trabajo no escroizado — decisión manual.`,
      );
    } else if (!matched) {
      // Candidatos ilegibles este ciclo: el intent sobrevive y reintenta —
      // discard solo con evidencia completa de que no hay Funded matching.
      staleIntents++;
      console.warn(`settle reconcile: intent ${intent.jobKey.slice(0, 12)}… con candidatos ilegibles (RPC) — se reintenta, no se descarta`);
    }
  }

  // Fase 2: huérfanos puros — Funded on-chain del operador que el journal no
  // conoce ni como pending ni como intent (pérdida total de la fila).
  let orphans = 0;
  for (const f of await fetchFunded()) {
    if (known.has(f.jobId)) continue;
    const job = await readJob(f.jobId).catch(() => null);
    if (job?.state !== 0) continue; // ya Released/Refunded — no es huérfano
    orphans++;
    console.warn(
      `settle reconcile: HUÉRFANO job ${f.jobId} → worker ${job.worker} — sin proof en journal. Recupera por forge self-claim o refund del operador a las 24h.`,
    );
  }
  return { recovered, orphans, staleIntents };
}

// — S52: runner stateful del reconciler (spec 005) —
// reconcileEvmOrphans es puro (matching); createEvmReconciler decide QUÉ
// bloques escanear y CUÁNDO: guard anti-solape + cursor durable.
export interface ScanCursor {
  load(): Promise<bigint | null>;
  save(head: bigint): Promise<void>;
}

export class InMemoryScanCursor implements ScanCursor {
  private head: bigint | null = null;
  async load(): Promise<bigint | null> {
    return this.head;
  }
  async save(head: bigint): Promise<void> {
    this.head = head;
  }
}

// Re-scan de seguridad tras el cursor: los logs de los últimos N bloques se
// re-lee siempre — cubre reorgs (un Funded puede reaparecer removido) y la
// carrera entre headBlock y el minado del propio Funded.
export const REORG_OVERLAP_BLOCKS = 64n;

export type ReconcileRunResult = { skipped: boolean; recovered: number; orphans: number; staleIntents: number };

export function createEvmReconciler(deps: {
  submitter: Pick<EvmSubmitter, "invoke">;
  journal: IntentJournal;
  escrow: Address;
  // Cabeza de chain actual (eth_blockNumber).
  headBlock: () => Promise<bigint>;
  // Scanner de la ventana [from,to] — la paginación eth_getLogs vive afuera.
  fetchFundedRange: (from: bigint, to: bigint, worker?: Address) => Promise<FundedJob[]>;
  readJob: (jobId: number) => Promise<{ state: number; worker: Address } | null>;
  // Durable en prod (PostgresScanCursor); in-memory en dev/tests.
  cursor?: ScanCursor;
  // Primer arranque sin cursor: floor explícito (EVM_ESCROW_FROM_BLOCK) o
  // lookback desde head. Floor siempre gana sobre el cursor-overlap.
  fromBlockFloor?: bigint;
  lookback?: bigint;
}): { run(): Promise<ReconcileRunResult> } {
  const { submitter, journal, escrow, headBlock, fetchFundedRange, readJob, cursor, fromBlockFloor, lookback } = deps;
  let running = false;

  async function run(): Promise<ReconcileRunResult> {
    if (running) return { skipped: true, recovered: 0, orphans: 0, staleIntents: 0 };
    running = true;
    try {
      const head = await headBlock();
      const saved = cursor ? await cursor.load() : null;
      let from: bigint;
      if (saved !== null) {
        from = saved > REORG_OVERLAP_BLOCKS ? saved - REORG_OVERLAP_BLOCKS : 0n;
      } else if (fromBlockFloor !== undefined) {
        from = fromBlockFloor;
      } else {
        from = head - (lookback ?? 500_000n);
      }
      if (fromBlockFloor !== undefined && from < fromBlockFloor) from = fromBlockFloor;
      if (from < 0n) from = 0n;

      const fetchFunded = (worker?: Address) => fetchFundedRange(from, head, worker);
      const r = await reconcileEvmOrphans({ submitter, journal, escrow, fetchFunded, readJob });

      // El cursor SOLO avanza cuando no quedan intents sin resolver: un intent
      // pendiente cuyo Funded quede detrás del cursor jamás se re-escanearía
      // — plata recuperable convertida en huérfano permanente. Con intents
      // abiertos la ventana se mantiene hasta que se attacheen o descarten.
      if (cursor && (await journal.intentsWithoutJob()).length === 0) {
        await cursor.save(head);
      }
      return { skipped: false, ...r };
    } finally {
      running = false;
    }
  }

  return { run };
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
