// E2E wire real (S45 sobre ADR-0005): dos daemons WS conectados al gateway
// completo — challenge REST → auth firmada (dualVerify real) → heartbeat →
// RemoteForgeExec → attest real → RoutedExec+Failover. El primer daemon muere
// mid-stream; el segundo recibe job.assign CON resume.prefix y su proof ata
// prefijo+sufijo. Nada stubeado salvo el engine local de cada daemon.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import type { ExecRequest, ForgeExec, StreamChunk } from "@weaver/forge-exec";
import type { ForgeDaemon } from "@weaver/forge";
import { startStack, upDaemon, isAttest, untilAttested, chatStream, type Stack } from "./harness.ts";

// Engine scripteado: A emite 2 tokens visibles y muere; B graba el resume que
// le llega y completa.
class DiesMidStream implements ForgeExec {
  readonly forgeId = "aaa-primero";
  readonly model = "qwen3.5:4b";
  async *execute(req: ExecRequest): AsyncIterable<StreamChunk> {
    if (isAttest(req)) {
      yield { token: "ok", done: false };
      yield { token: "", done: true, stats: { genTokens: 1, decodeMs: 5 } };
      return;
    }
    yield { token: "AAAA ", done: false };
    yield { token: "BBBB ", done: false };
    throw new Error("engine murió mid-stream");
  }
}

class RecordsResume implements ForgeExec {
  readonly forgeId = "zzz-rescue";
  readonly model = "qwen3.5:4b";
  sawResume?: { prefix: string };
  async *execute(req: ExecRequest): AsyncIterable<StreamChunk> {
    if (!isAttest(req)) this.sawResume = req.resume;
    yield { token: "CCCC", done: false };
    yield { token: "", done: true, stats: { genTokens: 1, decodeMs: 5 } };
  }
}

describe("E2E resume sobre daemon remoto real", () => {
  let stack: Stack | null = null;
  const daemons: ForgeDaemon[] = [];
  after(() => {
    for (const d of daemons) d.stop();
    stack?.close();
  });

  it("daemon A muere mid-stream → B recibe resume.prefix y completa", async () => {
    stack = await startStack();
    const b = new RecordsResume();
    daemons.push((await upDaemon(stack, "aaa-primero", new DiesMidStream())).daemon);
    daemons.push((await upDaemon(stack, "zzz-rescue", b)).daemon);

    // Esperar attestation de ambos (jobs attest-* reales por el canal).
    await untilAttested(stack.registry, 2);
    assert.equal(stack.registry.views().filter((v) => v.attested).length, 2, "ambos attested");

    const text = await chatStream(stack.url);

    // El stream entero: prefijo de A + continuación de B + frame de ruta.
    assert.match(text, /AAAA /);
    assert.match(text, /BBBB /);
    assert.match(text, /CCCC/);
    assert.match(text, /resumedPrefixLen":10/); // "AAAA BBBB " = 10 chars
    assert.match(text, /\[DONE\]/);
    // El wire llevó el prefijo: el exec del daemon B lo recibió en job.assign.
    assert.deepEqual(b.sawResume, { prefix: "AAAA BBBB " });
  });
});
