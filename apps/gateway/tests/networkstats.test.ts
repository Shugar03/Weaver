// spec 008 — /v1/network/* lee el índice Envio (IndexerStore).
// Datos on-chain puros: sin store → 404, sin datos → zeros honestos.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.ts";
import { FakeForgeExec } from "@weaver/forge-exec";
import { InMemoryIndexerStore } from "../src/indexerstore.ts";

const view = (forgeId: string) => ({
  forgeId,
  model: "qwen3:4b",
  hot: true,
  rttMs: 1,
  queueMs: 0,
  loadTimeMs: 0,
  price: 0,
  reliability: 1,
});
const forges = () => [view("fake-forge")];

describe("spec 008 /v1/network/*", () => {
  it("sin indexerStore → 404 honesto (no fabrica métricas)", async () => {
    const app = createApp({ forges, exec: new FakeForgeExec() });
    for (const path of ["/v1/network/stats", "/v1/network/leaderboard", "/v1/network/reputation?agentId=1"]) {
      const res = await app.request(path);
      assert.equal(res.status, 404, `${path} debe 404 sin store`);
    }
  });

  it("/v1/network/stats devuelve contadores indexados + bloque", async () => {
    const store = new InMemoryIndexerStore({
      metric: {
        totalJobsFunded: 7,
        totalJobsReleased: 6,
        totalJobsRefunded: 1,
        totalVolumeUsdc: 70_000_000n,
        totalDepositedUsdc: 200_000_000n,
        totalFeedbacks: 4,
      },
      indexedAtBlock: 67_950_000,
    });
    const app = createApp({ forges, exec: new FakeForgeExec(), indexerStore: store });
    const res = await app.request("/v1/network/stats");
    assert.equal(res.status, 200);
    const s = (await res.json()) as {
      funded: number;
      released: number;
      refunded: number;
      volumeUsdc: string;
      depositedUsdc: string;
      feedbacks: number;
      indexedAtBlock: number;
    };
    assert.equal(s.funded, 7);
    assert.equal(s.released, 6);
    assert.equal(s.refunded, 1);
    assert.equal(s.volumeUsdc, "70000000"); // bigint → string (JSON-safe)
    assert.equal(s.depositedUsdc, "200000000");
    assert.equal(s.feedbacks, 4);
    assert.equal(s.indexedAtBlock, 67_950_000);
  });

  it("store vacío → zeros honestos, no crash ni datos inventados", async () => {
    const store = new InMemoryIndexerStore();
    const app = createApp({ forges, exec: new FakeForgeExec(), indexerStore: store });
    const res = await app.request("/v1/network/stats");
    assert.equal(res.status, 200);
    const s = (await res.json()) as { funded: number; released: number; indexedAtBlock: number };
    assert.equal(s.funded, 0);
    assert.equal(s.released, 0);
    assert.equal(s.indexedAtBlock, 0);
  });

  it("/v1/network/leaderboard ordena por earned desc y expone stats del forge", async () => {
    const store = new InMemoryIndexerStore({
      forges: [
        {
          worker: "0xaaa",
          signer: "0x111",
          registeredTx: "0xtx1",
          registeredAtBlock: 100n,
          totalEarnedUsdc: 5_000_000n,
          completedJobsCount: 1,
          refundedJobsCount: 0,
        },
        {
          worker: "0xbbb",
          signer: "0x222",
          registeredTx: "0xtx2",
          registeredAtBlock: 90n,
          totalEarnedUsdc: 50_000_000n,
          completedJobsCount: 9,
          refundedJobsCount: 2,
        },
      ],
    });
    const app = createApp({ forges, exec: new FakeForgeExec(), indexerStore: store });
    const res = await app.request("/v1/network/leaderboard");
    assert.equal(res.status, 200);
    const rows = (await res.json()) as {
      worker: string;
      earnedUsdc: string;
      completedJobs: number;
      refundedJobs: number;
    }[];
    assert.equal(rows.length, 2);
    assert.equal(rows[0].worker, "0xbbb"); // mayor earned primero
    assert.equal(rows[0].earnedUsdc, "50000000");
    assert.equal(rows[0].completedJobs, 9);
    assert.equal(rows[0].refundedJobs, 2);
    assert.equal(rows[1].worker, "0xaaa");
  });

  it("/v1/network/reputation agrega feedbacks por agentId (avg decimal-safe, revoked fuera del avg)", async () => {
    const store = new InMemoryIndexerStore({
      feedbacks: [
        // 5.00 score (value 500 con 2 decimales)
        {
          agentId: 1990n,
          clientAddress: "0xc1",
          feedbackIndex: 0n,
          value: 500n,
          valueDecimals: 2,
          tag1: "speed",
          tag2: "accuracy",
          endpoint: "https://f/v1",
          feedbackURI: "ipfs://a",
          feedbackHash: "0x01",
          txHash: "0xtx1",
          blockNumber: 100n,
          revoked: false,
        },
        // 4.0 score (value 40 con 1 decimal)
        {
          agentId: 1990n,
          clientAddress: "0xc2",
          feedbackIndex: 1n,
          value: 40n,
          valueDecimals: 1,
          tag1: "reliability",
          tag2: "speed",
          endpoint: "https://f/v1",
          feedbackURI: "ipfs://b",
          feedbackHash: "0x02",
          txHash: "0xtx2",
          blockNumber: 101n,
          revoked: false,
        },
        // revocado: cuenta en count, no en avg
        {
          agentId: 1990n,
          clientAddress: "0xc3",
          feedbackIndex: 2n,
          value: 100n,
          valueDecimals: 0,
          tag1: "x",
          tag2: "y",
          endpoint: "e",
          feedbackURI: "u",
          feedbackHash: "0x03",
          txHash: "0xtx3",
          blockNumber: 102n,
          revoked: true,
        },
        // otro agente: no debe contaminar
        {
          agentId: 7n,
          clientAddress: "0xc9",
          feedbackIndex: 0n,
          value: 10n,
          valueDecimals: 0,
          tag1: "x",
          tag2: "y",
          endpoint: "e",
          feedbackURI: "u",
          feedbackHash: "0x04",
          txHash: "0xtx4",
          blockNumber: 103n,
          revoked: false,
        },
      ],
    });
    const app = createApp({ forges, exec: new FakeForgeExec(), indexerStore: store });
    const res = await app.request("/v1/network/reputation?agentId=1990");
    assert.equal(res.status, 200);
    const rep = (await res.json()) as {
      agentId: string;
      count: number;
      avgScore: number;
      feedbacks: { value: string; revoked: boolean }[];
    };
    assert.equal(rep.agentId, "1990");
    assert.equal(rep.count, 3); // incluye revocado
    assert.equal(rep.avgScore, 4.5); // (5.00 + 4.0) / 2 — el revocado no pesa
    assert.equal(rep.feedbacks.length, 3);
  });

  it("reputation sin agentId → 400; agente sin feedbacks → respuesta vacía honesta", async () => {
    const store = new InMemoryIndexerStore();
    const app = createApp({ forges, exec: new FakeForgeExec(), indexerStore: store });
    const bad = await app.request("/v1/network/reputation");
    assert.equal(bad.status, 400);
    const res = await app.request("/v1/network/reputation?agentId=9999");
    assert.equal(res.status, 200);
    const rep = (await res.json()) as { count: number; avgScore: number | null; feedbacks: unknown[] };
    assert.equal(rep.count, 0);
    assert.equal(rep.avgScore, null); // null honesto — no 0.0 fabricado
    assert.equal(rep.feedbacks.length, 0);
  });
});
