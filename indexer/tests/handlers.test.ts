import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createTestIndexer } from "envio";
import "../src/EventHandlers.ts";

const CHAIN_ID = 10143;
const CLIENT = "0x1111111111111111111111111111111111111111";
const WORKER = "0x2222222222222222222222222222222222222222";
const SIGNER = "0x3333333333333333333333333333333333333333";

describe("Weaver HyperIndex Handlers", () => {
  test("processes WeaverCredits.Deposited event", async () => {
    const indexer = createTestIndexer();
    const account = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd";
    const amount = 50_000_000n; // 50 USDC

    await indexer.process({
      chains: {
        [CHAIN_ID]: {
          simulate: [
            {
              contract: "WeaverCredits",
              event: "Deposited",
              params: {
                account,
                payer: CLIENT,
                amount,
              },
            },
          ],
        },
      },
    });

    const metric = await indexer.ProtocolMetric.getOrThrow("global");
    assert.equal(metric.totalDepositedUsdc, amount);

    const deposits = await indexer.Deposit.getAll();
    assert.equal(deposits.length, 1);
    assert.equal(deposits[0].account, account);
    assert.equal(deposits[0].payer, CLIENT);
    assert.equal(deposits[0].amount, amount);
  });

  test("processes WeaverEscrow.ForgeRegistered event", async () => {
    const indexer = createTestIndexer();

    await indexer.process({
      chains: {
        [CHAIN_ID]: {
          simulate: [
            {
              contract: "WeaverEscrow",
              event: "ForgeRegistered",
              params: {
                worker: WORKER,
                signer: SIGNER,
              },
            },
          ],
        },
      },
    });

    const worker = await indexer.Forge.getOrThrow(WORKER.toLowerCase());
    assert.equal(worker.worker, WORKER);
    assert.equal(worker.signer, SIGNER);
    assert.equal(worker.totalEarnedUsdc, 0n);
    assert.equal(worker.completedJobsCount, 0);
    assert.equal(worker.refundedJobsCount, 0);
  });

  test("processes WeaverEscrow.Funded and Released lifecycle", async () => {
    const indexer = createTestIndexer();
    const jobId = 101n;
    const amount = 10_000_000n; // 10 USDC
    const resultHash = "0x9f9f03227dd1af68d0b71b214336cb3d84162aff5365be7e9567706be4f12695";

    // 1. Register Forge + Fund Job
    await indexer.process({
      chains: {
        [CHAIN_ID]: {
          simulate: [
            {
              contract: "WeaverEscrow",
              event: "ForgeRegistered",
              params: { worker: WORKER, signer: SIGNER },
            },
            {
              contract: "WeaverEscrow",
              event: "Funded",
              params: { jobId, client: CLIENT, worker: WORKER, amount },
            },
          ],
        },
      },
    });

    let job = await indexer.Job.getOrThrow(jobId.toString());
    assert.equal(job.state, "funded");
    assert.equal(job.amount, amount);
    assert.equal(job.client, CLIENT);
    assert.equal(job.worker, WORKER);
    assert.equal(job.resultHash, undefined);

    let metric = await indexer.ProtocolMetric.getOrThrow("global");
    assert.equal(metric.totalJobsFunded, 1);
    assert.equal(metric.totalVolumeUsdc, amount);
    assert.equal(metric.totalJobsReleased, 0);

    // 2. Release Job
    await indexer.process({
      chains: {
        [CHAIN_ID]: {
          simulate: [
            {
              contract: "WeaverEscrow",
              event: "Released",
              params: { jobId, worker: WORKER, amount, resultHash },
            },
          ],
        },
      },
    });

    job = await indexer.Job.getOrThrow(jobId.toString());
    assert.equal(job.state, "released");
    assert.equal(job.resultHash, resultHash);

    const worker = await indexer.Forge.getOrThrow(WORKER.toLowerCase());
    assert.equal(worker.totalEarnedUsdc, amount);
    assert.equal(worker.completedJobsCount, 1);

    metric = await indexer.ProtocolMetric.getOrThrow("global");
    assert.equal(metric.totalJobsReleased, 1);
  });

  test("processes WeaverEscrow.Funded and Refunded lifecycle", async () => {
    const indexer = createTestIndexer();
    const jobId = 202n;
    const amount = 5_000_000n; // 5 USDC

    // 1. Register Forge + Fund Job (ciclo real: el forge está registrado
    // antes de recibir jobs — los stats se atribuyen a forges existentes)
    await indexer.process({
      chains: {
        [CHAIN_ID]: {
          simulate: [
            {
              contract: "WeaverEscrow",
              event: "ForgeRegistered",
              params: { worker: WORKER, signer: SIGNER },
            },
            {
              contract: "WeaverEscrow",
              event: "Funded",
              params: { jobId, client: CLIENT, worker: WORKER, amount },
            },
          ],
        },
      },
    });

    let job = await indexer.Job.getOrThrow(jobId.toString());
    assert.equal(job.state, "funded");

    // 2. Refund Job
    await indexer.process({
      chains: {
        [CHAIN_ID]: {
          simulate: [
            {
              contract: "WeaverEscrow",
              event: "Refunded",
              params: { jobId, client: CLIENT, amount },
            },
          ],
        },
      },
    });

    job = await indexer.Job.getOrThrow(jobId.toString());
    assert.equal(job.state, "refunded");

    const worker = await indexer.Forge.getOrThrow(WORKER.toLowerCase());
    assert.equal(worker.refundedJobsCount, 1);
    assert.equal(worker.completedJobsCount, 0);
    assert.equal(worker.totalEarnedUsdc, 0n);

    const metric = await indexer.ProtocolMetric.getOrThrow("global");
    assert.equal(metric.totalJobsRefunded, 1);
  });

  test("processes ERC8004Reputation.NewFeedback event", async () => {
    const indexer = createTestIndexer();
    const agentId = 1991n;
    const feedbackIndex = 1n;
    const value = 500n;
    const valueDecimals = 2n; // 5.00 rating
    const tag1 = "inference_speed";
    const tag2 = "accuracy";
    const endpoint = "https://forge.weaver.network/v1";
    const feedbackURI = "ipfs://QmWeaverFeedback1991";
    const feedbackHash = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

    await indexer.process({
      chains: {
        [CHAIN_ID]: {
          simulate: [
            {
              contract: "ReputationRegistry",
              event: "NewFeedback",
              params: {
                agentId,
                clientAddress: CLIENT,
                indexedTag1: tag1,
                feedbackIndex,
                value,
                valueDecimals,
                tag1,
                tag2,
                endpoint,
                feedbackURI,
                feedbackHash,
              },
            },
          ],
        },
      },
    });

    const feedbacks = await indexer.Feedback.getAll();
    assert.equal(feedbacks.length, 1);
    assert.equal(feedbacks[0].agentId, agentId);
    assert.equal(feedbacks[0].clientAddress, CLIENT);
    assert.equal(feedbacks[0].value, value);
    assert.equal(feedbacks[0].valueDecimals, 2);
    assert.equal(feedbacks[0].tag1, tag1);
    assert.equal(feedbacks[0].tag2, tag2);
    assert.equal(feedbacks[0].feedbackURI, feedbackURI);
    assert.equal(feedbacks[0].feedbackHash, feedbackHash);

    const metric = await indexer.ProtocolMetric.getOrThrow("global");
    assert.equal(metric.totalFeedbacks, 1);
  });

  test("aggregates cumulative protocol metrics across multiple events", async () => {
    const indexer = createTestIndexer();

    await indexer.process({
      chains: {
        [CHAIN_ID]: {
          simulate: [
            // 2 deposits (30 USDC + 20 USDC = 50 USDC)
            {
              contract: "WeaverCredits",
              event: "Deposited",
              params: {
                account: "0x1111000000000000000000000000000000000000000000000000000000000000",
                payer: CLIENT,
                amount: 30_000_000n,
              },
            },
            {
              contract: "WeaverCredits",
              event: "Deposited",
              params: {
                account: "0x2222000000000000000000000000000000000000000000000000000000000000",
                payer: CLIENT,
                amount: 20_000_000n,
              },
            },
            // Register forge
            {
              contract: "WeaverEscrow",
              event: "ForgeRegistered",
              params: { worker: WORKER, signer: SIGNER },
            },
            // Fund Job 1 (10 USDC) & Job 2 (15 USDC)
            {
              contract: "WeaverEscrow",
              event: "Funded",
              params: { jobId: 1n, client: CLIENT, worker: WORKER, amount: 10_000_000n },
            },
            {
              contract: "WeaverEscrow",
              event: "Funded",
              params: { jobId: 2n, client: CLIENT, worker: WORKER, amount: 15_000_000n },
            },
            // Release Job 1
            {
              contract: "WeaverEscrow",
              event: "Released",
              params: {
                jobId: 1n,
                worker: WORKER,
                amount: 10_000_000n,
                resultHash: "0xaaaa000000000000000000000000000000000000000000000000000000000000",
              },
            },
            // Refund Job 2
            {
              contract: "WeaverEscrow",
              event: "Refunded",
              params: { jobId: 2n, client: CLIENT, amount: 15_000_000n },
            },
            // Feedback
            {
              contract: "ReputationRegistry",
              event: "NewFeedback",
              params: {
                agentId: 1990n,
                clientAddress: CLIENT,
                indexedTag1: "reliability",
                feedbackIndex: 0n,
                value: 480n,
                valueDecimals: 2n,
                tag1: "reliability",
                tag2: "speed",
                endpoint: "https://forge.weaver.network/v1",
                feedbackURI: "ipfs://test",
                feedbackHash: "0xbbbb000000000000000000000000000000000000000000000000000000000000",
              },
            },
          ],
        },
      },
    });

    const metric = await indexer.ProtocolMetric.getOrThrow("global");
    assert.equal(metric.totalDepositedUsdc, 50_000_000n);
    assert.equal(metric.totalJobsFunded, 2);
    assert.equal(metric.totalJobsReleased, 1);
    assert.equal(metric.totalJobsRefunded, 1);
    assert.equal(metric.totalVolumeUsdc, 25_000_000n);
    assert.equal(metric.totalFeedbacks, 1);

    const worker = await indexer.Forge.getOrThrow(WORKER.toLowerCase());
    assert.equal(worker.completedJobsCount, 1);
    assert.equal(worker.refundedJobsCount, 1);
    assert.equal(worker.totalEarnedUsdc, 10_000_000n);
  });
});
