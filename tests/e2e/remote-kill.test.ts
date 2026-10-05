// E2E kill switch sobre wire real (spec 011): setDead cierra la sesión del
// pubkey dueño — el job en vuelo falla midStream → failover+resume en el
// sobreviviente. Y el DAEMON aborta su engine cuando el canal muere (sin
// esto quemaba GPU para un gateway que ya no escuchaba).
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import type { ExecRequest, ForgeExec, StreamChunk } from "@weaver/forge-exec";
import type { ForgeDaemon } from "@weaver/forge";
import { startStack, upDaemon, isAttest, untilAttested, chatRequest, readUntil, sleep, type Stack } from "./harness.ts";

// Emite 2 tokens visibles y se queda esperando — el kill lo encuentra
// mid-stream. Si el daemon aborta el exec al morir el canal → aborted=true.
class SlowVictim implements ForgeExec {
  readonly forgeId = "aaa-victim";
  readonly model = "qwen3.5:4b";
  aborted = false;
  private emitReady!: () => void;
  readonly emitted = new Promise<void>((r) => (this.emitReady = r));
  async *execute(req: ExecRequest): AsyncIterable<StreamChunk> {
    if (isAttest(req)) {
      yield { token: "ok", done: false };
      yield { token: "", done: true, stats: { genTokens: 1, decodeMs: 5 } };
      return;
    }
    yield { token: "AAAA ", done: false };
    yield { token: "BBBB ", done: false };
    this.emitReady();
    await new Promise<void>((res) => {
      req.signal?.addEventListener("abort", () => {
        this.aborted = true;
        res();
      });
    });
    throw new Error("engine abortado");
  }
}

class Serves implements ForgeExec {
  readonly forgeId = "zzz-rescue";
  readonly model = "qwen3.5:4b";
  sawResume?: { prefix: string };
  async *execute(req: ExecRequest): AsyncIterable<StreamChunk> {
    if (!isAttest(req)) this.sawResume = req.resume;
    yield { token: "CCCC", done: false };
    yield { token: "", done: true, stats: { genTokens: 1, decodeMs: 5 } };
  }
}

describe("E2E kill remoto mid-job", () => {
  let stack: Stack | null = null;
  const daemons: ForgeDaemon[] = [];
  after(() => {
    for (const d of daemons) d.stop();
    stack?.close();
  });

  it("setDead mid-stream → failover resume en B + daemon aborta su engine + reconnect bloqueado", async () => {
    stack = await startStack();
    const a = new SlowVictim();
    const b = new Serves();
    const { daemon: da, kp: kpA } = await upDaemon(stack, "aaa-victim", a);
    daemons.push(da);
    daemons.push((await upDaemon(stack, "zzz-rescue", b)).daemon);
    await untilAttested(stack.registry, 2);

    // Chat en vuelo: esperar a que el CLIENTE haya visto el prefijo de A
    // (emit-ready local ≠ entregado — kill antes de entrega no tiene prefijo).
    const res = await chatRequest(stack.url);
    let acc = await readUntil(res, "", "BBBB");
    await a.emitted;
    assert.equal(stack.fws.setDead("aaa-victim", true), true);
    const text = await readUntil(res, acc, "[DONE]");
    assert.match(text, /AAAA /);
    assert.match(text, /BBBB /);
    assert.match(text, /CCCC/); // el rescue completó
    assert.match(text, /resumedPrefixLen":10/);
    assert.match(text, /\[DONE\]/);
    assert.deepEqual(b.sawResume, { prefix: "AAAA BBBB " });

    // El daemon recibió el close → el engine abortó (no GPU zombie).
    await sleep(150);
    assert.equal(a.aborted, true, "el engine del daemon debía abortar al morir el canal");

    // Reconexión con la MISMA pubkey: el auth.ok llega pero el gateway cierra
    // la sesión al toque (4005 en onAuthed) — la instance nunca queda ruteable.
    const blocked = await upDaemon(stack, "aaa-victim-2", new Serves(), kpA);
    daemons.push(blocked.daemon);
    await sleep(250);
    assert.equal(
      stack.registry.views().some((v) => v.forgeId === "aaa-victim-2"),
      false,
      "pubkey matada: la sesión re-autenticada no debe registrar instances",
    );
    // Revive por instanceId (el kill recuerda instanceId→pubkey pese al
    // unregister) → la próxima auth entra y la instance se registra.
    assert.equal(stack.fws.setDead("aaa-victim", false), true);
    const revived = await upDaemon(stack, "aaa-victim-3", new Serves(), kpA);
    daemons.push(revived.daemon);
    await sleep(200);
    assert.ok(
      stack.registry.views().some((v) => v.forgeId === "aaa-victim-3"),
      "revive re-habilita la pubkey",
    );
  });
});
