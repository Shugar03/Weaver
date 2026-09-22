// Media — POST /v1/images/generations + GET /v1/media/:id con ImageExec fake.
// La ruta pasa por el scheduler real: el test verifica routing, telemetría
// honesta de fallos y el ciclo artefacto → URL → bytes servidos.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.ts";

const forges = () => [
  { forgeId: "image-local", model: "flux2-klein-4b", capability: "image" as const, hot: false, rttMs: 5, queueMs: 0, loadTimeMs: 20_000, price: 0, reliability: 1 },
];
const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]).toString("base64"); // magic PNG

const fakeImage = (ms = 7) => ({
  forgeId: "image-local",
  model: "flux2-klein-4b",
  async generateImage() {
    return { forgeId: "image-local", b64: PNG_B64, ms };
  },
});

describe("POST /v1/images/generations", () => {
  it("rutea por scheduler, devuelve b64 + media URL y sirve el artefacto", async () => {
    const media = new Map<string, { buf: Buffer; mime: string }>();
    const app = createApp({ forges, imageExecs: { "image-local": fakeImage(7) }, media });
    const res = await app.request("/v1/images/generations", {
      method: "POST",
      body: JSON.stringify({ model: "flux2-klein-4b", prompt: "un telar" }),
    });
    assert.equal(res.status, 200);
    const j = (await res.json()) as {
      data: { b64_json: string; url: string }[];
      weaver: { forge: string; ms: number; reason: string };
    };
    assert.equal(j.weaver.forge, "image-local");
    assert.equal(j.weaver.ms, 7);
    assert.equal(j.data[0].b64_json, PNG_B64);
    assert.match(j.data[0].url, /^\/v1\/media\//);
    const img = await app.request(j.data[0].url);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get("content-type"), "image/png");
    assert.deepEqual([...new Uint8Array(await img.arrayBuffer())], [...Buffer.from(PNG_B64, "base64")]);
  });

  it("modelo sin forges → 404, no fake", async () => {
    const app = createApp({ forges, imageExecs: { "image-local": fakeImage() } });
    const res = await app.request("/v1/images/generations", {
      method: "POST",
      body: JSON.stringify({ model: "otro-modelo", prompt: "x" }),
    });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).code, "unknown_model");
  });

  it("view sin ImageExec registrado → 404 (no es candidato ruteable)", async () => {
    const app = createApp({ forges, imageExecs: {} });
    const res = await app.request("/v1/images/generations", {
      method: "POST",
      body: JSON.stringify({ model: "flux2-klein-4b", prompt: "x" }),
    });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).code, "unknown_model");
  });

  it("modelo de texto pedido a la ruta de imagen → 404, no dispatch cruzado", async () => {
    const mixed = () => [
      { forgeId: "ollama-local", model: "qwen3:4b", hot: true, rttMs: 5, queueMs: 0, loadTimeMs: 0, price: 0, reliability: 1 },
      { forgeId: "image-local", model: "flux2-klein-4b", capability: "image" as const, hot: false, rttMs: 5, queueMs: 0, loadTimeMs: 20_000, price: 0, reliability: 1 },
    ];
    const app = createApp({ forges: mixed, imageExecs: { "image-local": fakeImage() } });
    const res = await app.request("/v1/images/generations", {
      method: "POST",
      body: JSON.stringify({ model: "qwen3:4b", prompt: "x" }),
    });
    assert.equal(res.status, 404);
  });

  it("forge falla → 502 con el error real", async () => {
    const app = createApp({
      forges,
      imageExecs: {
        "image-local": {
          forgeId: "image-local",
          model: "flux2-klein-4b",
          generateImage: async () => {
            throw new Error("runner roto");
          },
        },
      },
    });
    const res = await app.request("/v1/images/generations", {
      method: "POST",
      body: JSON.stringify({ model: "flux2-klein-4b", prompt: "x" }),
    });
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /runner roto/);
  });

  it("media inexistente → 404", async () => {
    const app = createApp({ forges, media: new Map() });
    assert.equal((await app.request("/v1/media/nope")).status, 404);
  });
});
