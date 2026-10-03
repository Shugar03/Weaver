// Weaver indexer — handlers de eventos on-chain (spec 006, envio v3).
// Solo datos de la chain: nada se inventa, todo es decodificación directa
// del log. Job se actualiza Funded→Released/Refunded en la misma entidad.
import { indexer, type EvmOnEventContext } from "envio";

const TX_HASH = { transaction: ["hash"] } as const;
const ZERO_METRIC = {
  id: "global",
  totalJobsFunded: 0,
  totalJobsReleased: 0,
  totalJobsRefunded: 0,
  totalVolumeUsdc: 0n,
  totalDepositedUsdc: 0n,
  totalFeedbacks: 0,
};

// Singleton: lee la fila o arranca en cero — suma `delta` y persiste.
const bumpMetric = async (
  context: EvmOnEventContext,
  delta: Partial<Omit<typeof ZERO_METRIC, "id">>,
) => {
  const m = (await context.ProtocolMetric.get("global")) ?? ZERO_METRIC;
  context.ProtocolMetric.set({
    id: "global",
    totalJobsFunded: m.totalJobsFunded + (delta.totalJobsFunded ?? 0),
    totalJobsReleased: m.totalJobsReleased + (delta.totalJobsReleased ?? 0),
    totalJobsRefunded: m.totalJobsRefunded + (delta.totalJobsRefunded ?? 0),
    totalVolumeUsdc: m.totalVolumeUsdc + (delta.totalVolumeUsdc ?? 0n),
    totalDepositedUsdc: m.totalDepositedUsdc + (delta.totalDepositedUsdc ?? 0n),
    totalFeedbacks: m.totalFeedbacks + (delta.totalFeedbacks ?? 0),
  });
};

indexer.onEvent(
  { contract: "WeaverEscrow", event: "ForgeRegistered", fields: TX_HASH },
  async ({ event, context }) => {
    context.Forge.set({
      id: event.params.worker.toLowerCase(),
      worker: event.params.worker,
      signer: event.params.signer,
      registeredTx: event.transaction.hash,
      registeredAtBlock: BigInt(event.block.number),
      totalEarnedUsdc: 0n,
      completedJobsCount: 0,
      refundedJobsCount: 0,
    });
  },
);

indexer.onEvent(
  { contract: "WeaverEscrow", event: "Funded", fields: { ...TX_HASH, block: ["timestamp"] } },
  async ({ event, context }) => {
    context.Job.set({
      id: event.params.jobId.toString(),
      jobId: event.params.jobId,
      client: event.params.client,
      worker: event.params.worker,
      amount: event.params.amount,
      state: "funded",
      fundTx: event.transaction.hash,
      fundedAtBlock: BigInt(event.block.number),
      fundedAtTs: BigInt(event.block.timestamp),
      releaseTx: undefined,
      releasedAtBlock: undefined,
      resultHash: undefined,
      refundTx: undefined,
    });
    await bumpMetric(context, { totalJobsFunded: 1, totalVolumeUsdc: event.params.amount });
  },
);

indexer.onEvent(
  { contract: "WeaverEscrow", event: "Released", fields: TX_HASH },
  async ({ event, context }) => {
    const id = event.params.jobId.toString();
    const job = await context.Job.get(id);
    context.Job.set({
      id,
      jobId: event.params.jobId,
      client: job?.client ?? "",
      worker: event.params.worker,
      amount: job?.amount ?? event.params.amount,
      state: "released",
      fundTx: job?.fundTx ?? "",
      fundedAtBlock: job?.fundedAtBlock ?? 0n,
      fundedAtTs: job?.fundedAtTs ?? 0n,
      releaseTx: event.transaction.hash,
      releasedAtBlock: BigInt(event.block.number),
      resultHash: event.params.resultHash,
      refundTx: undefined,
    });
    // Stats del forge: Released trae worker en params — se atribuye aunque
    // el Job no exista (release sin Funded indexado).
    const forge = await context.Forge.get(event.params.worker.toLowerCase());
    if (forge) {
      context.Forge.set({
        ...forge,
        totalEarnedUsdc: forge.totalEarnedUsdc + event.params.amount,
        completedJobsCount: forge.completedJobsCount + 1,
      });
    }
    await bumpMetric(context, { totalJobsReleased: 1 });
  },
);

indexer.onEvent(
  { contract: "WeaverEscrow", event: "Refunded", fields: TX_HASH },
  async ({ event, context }) => {
    const id = event.params.jobId.toString();
    const job = await context.Job.get(id);
    context.Job.set({
      id,
      jobId: event.params.jobId,
      client: event.params.client,
      worker: job?.worker ?? "",
      amount: event.params.amount,
      state: "refunded",
      fundTx: job?.fundTx ?? "",
      fundedAtBlock: job?.fundedAtBlock ?? 0n,
      fundedAtTs: job?.fundedAtTs ?? 0n,
      releaseTx: undefined,
      releasedAtBlock: undefined,
      resultHash: undefined,
      refundTx: event.transaction.hash,
    });
    // Refunded no trae worker — se atribuye al forge del Job indexado.
    if (job?.worker) {
      const forge = await context.Forge.get(job.worker.toLowerCase());
      if (forge) {
        context.Forge.set({ ...forge, refundedJobsCount: forge.refundedJobsCount + 1 });
      }
    }
    await bumpMetric(context, { totalJobsRefunded: 1 });
  },
);

indexer.onEvent(
  { contract: "WeaverCredits", event: "Deposited", fields: { ...TX_HASH, block: ["timestamp"] } },
  async ({ event, context }) => {
    context.Deposit.set({
      id: `${event.transaction.hash}-${event.logIndex}`,
      account: event.params.account,
      payer: event.params.payer,
      amount: event.params.amount,
      txHash: event.transaction.hash,
      blockNumber: BigInt(event.block.number),
      timestamp: BigInt(event.block.timestamp),
    });
    await bumpMetric(context, { totalDepositedUsdc: event.params.amount });
  },
);

indexer.onEvent(
  { contract: "IdentityRegistry", event: "Registered", fields: TX_HASH },
  async ({ event, context }) => {
    context.Agent.set({
      id: event.params.agentId.toString(),
      agentId: event.params.agentId,
      owner: event.params.owner,
      agentURI: event.params.agentURI,
      registeredTx: event.transaction.hash,
      registeredAtBlock: BigInt(event.block.number),
    });
  },
);

indexer.onEvent({ contract: "IdentityRegistry", event: "URIUpdated" }, async ({ event, context }) => {
  const id = event.params.agentId.toString();
  const agent = await context.Agent.get(id);
  if (!agent) return; // registrado antes de start_block — se conserva lo indexado
  context.Agent.set({ ...agent, agentURI: event.params.newURI });
});

indexer.onEvent(
  { contract: "ReputationRegistry", event: "NewFeedback", fields: TX_HASH },
  async ({ event, context }) => {
    context.Feedback.set({
      id: `${event.params.agentId}-${event.params.clientAddress.toLowerCase()}-${event.params.feedbackIndex}`,
      agentId: event.params.agentId,
      clientAddress: event.params.clientAddress,
      feedbackIndex: event.params.feedbackIndex,
      value: event.params.value,
      valueDecimals: Number(event.params.valueDecimals),
      tag1: event.params.tag1,
      tag2: event.params.tag2,
      endpoint: event.params.endpoint,
      feedbackURI: event.params.feedbackURI,
      feedbackHash: event.params.feedbackHash,
      txHash: event.transaction.hash,
      blockNumber: BigInt(event.block.number),
      revoked: false,
    });
    await bumpMetric(context, { totalFeedbacks: 1 });
  },
);

indexer.onEvent({ contract: "ReputationRegistry", event: "FeedbackRevoked" }, async ({ event, context }) => {
  const id = `${event.params.agentId}-${event.params.clientAddress.toLowerCase()}-${event.params.feedbackIndex}`;
  const fb = await context.Feedback.get(id);
  if (!fb) return;
  context.Feedback.set({ ...fb, revoked: true });
});
