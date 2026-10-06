// E2E imagen sobre wire real (S40): daemon con capability "image" → heartbeat
// → syncExecs crea RemoteImageExec → attestImage dispara image.assign REAL por
// el canal (el resultado debe decodificar a imagen con dims) → POST
// /v1/images/generations rutea por scheduler y sirve el artefacto.
// Segundo caso: forge que pasa attestation pero devuelve basura en el job real
// → el gateway no sirve lo inválido (502 honesto, media intacta).
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import type { ImageExec, ImageRequest, ImageResult } from "@weaver/forge-exec";
import type { ForgeDaemon } from "@weaver/forge";
import { imageDims } from "@weaver/forge-net";
import { startStack, upImageDaemon, isAttest, untilAttested, noisyPng, type Stack } from "./harness.ts";

class PngForge implements ImageExec {
  readonly forgeId = "img-a";
  readonly model = "flux2-klein-4b";
  prompts: string[] = [];
  async generateImage(req: ImageRequest): Promise<ImageResult> {
    if (!isAttest(req)) this.prompts.push(req.prompt);
    return { forgeId: this.forgeId, b64: noisyPng(64, 64), ms: 7 };
  }
}

// Pasa attestation (PNG válido) y luego devuelve basura en jobs reales —
// el gateway no puede servirlo ni contarlo como éxito.
class GarbageAfterAttest implements ImageExec {
  readonly forgeId = "img-b";
  readonly model = "flux2-klein-4b";
  async generateImage(req: ImageRequest): Promise<ImageResult> {
    const b64 = isAttest(req)
      ? noisyPng(64, 64)
      : Buffer.from("esto no es una imagen").toString("base64");
    return { forgeId: this.forgeId, b64, ms: 3 };
  }
}

async function generate(url: string): Promise<Response> {
  return fetch(`${url}/v1/images/generations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "flux2-klein-4b", prompt: "un telar rojo, minimalista" }),
  });
}

describe("E2E imagen sobre daemon remoto", () => {
  // Cada it levanta su propio stack — after() debe cerrar TODOS, no el último
  // (un stack suelto deja server+fws abiertos y el proceso no termina).
  const stacks: Stack[] = [];
  const daemons: ForgeDaemon[] = [];
  const up = async (): Promise<Stack> => {
    const s = await startStack();
    stacks.push(s);
    return s;
  };
  after(() => {
    for (const d of daemons) d.stop();
    for (const s of stacks) s.close();
  });

  it("forge de imagen remoto: attestation real → POST sirve artefacto decodable + /v1/media", async () => {
    const stack = await up();
    const engine = new PngForge();
    daemons.push((await upImageDaemon(stack, "img-a", engine)).daemon);
    await untilAttested(stack.registry, 1);

    const res = await generate(stack.url);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      created: number;
      data: { b64_json: string; url?: string }[];
      weaver: { forge: string; ms: number };
    };
    const item = body.data[0];
    // Artefacto real: el b64 del wire decodifica a imagen con dims.
    assert.ok(imageDims(item.b64_json), "el resultado debe decodificar a imagen");
    assert.equal(body.weaver.forge, "img-a");
    assert.ok(engine.prompts.includes("un telar rojo, minimalista"), "el prompt llegó al engine");
    // Media servida: la URL guardada responde el PNG guardado.
    assert.ok(item.url?.startsWith("/v1/media/"));
    const media = await fetch(`${stack.url}${item.url}`);
    assert.equal(media.status, 200);
    assert.equal(media.headers.get("content-type"), "image/png");
    const buf = Buffer.from(await media.arrayBuffer());
    assert.equal(buf.toString("base64"), item.b64_json);
  });

  it("forge attested que devuelve basura en el job real → 502 forge_failed, nada se sirve", async () => {
    const stack = await up();
    daemons.push((await upImageDaemon(stack, "img-b", new GarbageAfterAttest())).daemon);
    await untilAttested(stack.registry, 1); // la attestation SÍ pasó — el engaño es post-attest

    const res = await generate(stack.url);
    assert.equal(res.status, 502);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, "forge_failed");
  });
});
