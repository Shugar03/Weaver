// E2E reconnect sobre wire real: el socket del daemon cae → connectLoop
// reintenta con backoff → nueva sesión (auth+heartbeat) → re-attestation →
// el forge vuelve a ser ruteable y sirve tráfico. En el gap el gateway
// degrada honesto (404 unknown_model), no cuelga ni sirve otro modelo.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import type { ExecRequest, ForgeExec, StreamChunk } from "@weaver/forge-exec";
import type { DaemonChannel } from "@weaver/forge-net";
import { stellarKeypair } from "@weaver/settlement";
import { connect, connectLoop, ForgeDaemon, type ForgeConfig } from "@weaver/forge";
import { startStack, isAttest, untilAttested, untilGone, chatRequest, readUntil, type Stack } from "./harness.ts";

class Serves implements ForgeExec {
  readonly forgeId = "reconnect-1";
  readonly model = "qwen3.5:4b";
  jobs = 0;
  async *execute(req: ExecRequest): AsyncIterable<StreamChunk> {
    if (!isAttest(req)) this.jobs++;
    yield { token: "VIVO", done: false };
    yield { token: "", done: true, stats: { genTokens: 1, decodeMs: 5 } };
  }
}

describe("E2E reconnect loop", () => {
  let stack: Stack | null = null;
  let cancel: (() => void) | null = null;
  const daemons: ForgeDaemon[] = [];
  after(() => {
    cancel?.();
    for (const d of daemons) d.stop();
    stack?.close();
  });

  it("socket cae → connectLoop reconecta → re-attested → vuelve a servir", async () => {
    stack = await startStack();
    const kp = stellarKeypair();
    const engine = new Serves();
    const channels: DaemonChannel[] = [];
    const logs: string[] = [];
    const cfg = {
      gateway: stack.url, chain: "stellar", pubkey: kp.pubkey, secret: kp.secret, instances: [],
    } as ForgeConfig;
    const loop = connectLoop(
      cfg,
      (ch) => {
        const d = new ForgeDaemon({
          channel: ch,
          instances: [{ instanceId: "reconnect-1", model: "qwen3.5:4b", capability: "text", exec: engine, maxConcurrent: 4, loadTimeMs: 0 }],
          sign: kp.sign,
          heartbeatMs: 550,
          probes: { idleMs: async () => null, vramUsedGb: async () => null },
        });
        daemons.push(d);
        return d;
      },
      (m) => logs.push(m),
      {
        // connect real (wire completo) + rand=0 → backoff determinístico 500ms.
        connect: async (c) => {
          const ch = await connect(c);
          channels.push(ch);
          return ch;
        },
        rand: () => 0,
      },
    );
    cancel = loop.cancel;
    await untilAttested(stack.registry, 1);

    // Sirve ANTES del drop.
    const res1 = await chatRequest(stack.url);
    const t1 = await readUntil(res1, "", "[DONE]");
    assert.match(t1, /VIVO/);
    assert.equal(engine.jobs, 1);

    // El socket cae (network drop): el canal del daemon muere, el session del
    // gateway se cierra → unregister → la instance sale de routing.
    channels[0].close!();
    await untilGone(stack.registry, "reconnect-1");

    // En el gap: degradación honesta — 404, no stream colgado.
    const gap = await chatRequest(stack.url);
    assert.equal(gap.status, 404);
    assert.equal(((await gap.json()) as { code: string }).code, "unknown_model");
    assert.ok(logs.some((m) => m.includes("reintento")), "el loop logueó el reintento");

    // El loop solo reconecta: nueva sesión → heartbeat → re-attestation real.
    await untilAttested(stack.registry, 1, 8000);
    assert.ok(channels.length >= 2, "connectLoop abrió una segunda conexión");

    // Y vuelve a servir tráfico por la sesión nueva.
    const res2 = await chatRequest(stack.url);
    const t2 = await readUntil(res2, "", "[DONE]");
    assert.match(t2, /VIVO/);
    assert.equal(engine.jobs, 2);
  });
});
