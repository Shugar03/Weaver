// S47 fase C — wire-e2e con PESOS REALES (spec 018).
// Dos stage_runner.py (capas 0-12 y 12-24 de Qwen2.5-0.5B, KV por sesión,
// ed25519 desde seed Stellar) + edge-runner (embed/norm/lm_head/tokenizer)
// + PipelineExec real + gateway real. Los tokens que salen del SSE son
// transformer de verdad — no sim. Paridad con el monolítico probada en
// tools/parity_check.py (Δ=0 exacto).
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import {
  startStack, untilAttested, upPyStageDaemon, upEdge,
  upPipelineDaemon,
} from "./harness.ts";
import { httpFront, type ForgeDaemon } from "@weaver/forge";
import type { ChildProcess } from "node:child_process";

const MODEL = process.env.STAGE_MODEL ?? "Qwen/Qwen2.5-0.5B";

describe("S47-C stage-federation con pesos reales (Qwen2.5-0.5B)", () => {
  const stacks: Awaited<ReturnType<typeof startStack>>[] = [];
  const daemons: ForgeDaemon[] = [];
  const procs: ChildProcess[] = [];

  after(async () => {
    for (const d of daemons) d.stop();
    for (const s of stacks) await s.close();
    for (const p of procs) p.kill("SIGKILL");
  });

  it("pipeline real: 2 stages HF por TCP + edge → tokens de verdad + stageSigs firmadas", { timeout: 300_000 }, async () => {
    const stack = await startStack();
    stacks.push(stack);

    // Infra real: edge + dos stages python (cada uno carga SU tramo del
    // checkpoint — nadie tiene el modelo entero salvo el "intent" lógico).
    const edge = await upEdge(MODEL);
    procs.push(edge.proc);
    const s1 = await upPyStageDaemon(stack, "ps1", [0, 12], MODEL);
    const s2 = await upPyStageDaemon(stack, "ps2", [12, 24], MODEL);
    procs.push(s1.proc, s2.proc);
    daemons.push(s1.daemon, s2.daemon);

    const c = await upPipelineDaemon(stack, "pc0", 24, MODEL, undefined, httpFront(edge.url));
    daemons.push(c.daemon);
    await untilAttested(stack.registry, 1, 60_000); // attest = job real por la cadena

    // max_tokens acotado: CPU + relay de 2 procesos ≈ 1-3s/tok — el pipeline
    // real es throughput, no TTFT.
    const res = await fetch(`${stack.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: "The capital of France is" }],
        stream: true,
        max_tokens: 12,
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /\[DONE\]/);
    // Greedy decode del checkpoint real — el monolítico produce " Paris"
    // como primer token; el pipeline por 2 procesos debe llegar igual.
    assert.match(body, /Paris/, `se esperaban tokens reales del modelo: ${body.slice(0, 400)}`);
    // stageSigs: cada runner python firmó su tramo con la key del daemon.
    const sigLine = body.split("\n").filter((l) => l.includes('"stageSigs"')).at(-1);
    assert.ok(sigLine, "el receipt debía traer stageSigs de los runners reales");
    const sigs = JSON.parse(sigLine.slice(5)).weaver_proof.stageSigs;
    assert.equal(sigs.length, 2);
    assert.deepEqual(
      sigs.map((s: { endpoint: string }) => s.endpoint).sort(),
      [s1.endpoint, s2.endpoint].sort(),
    );
    assert.ok(sigs.every((s: { sig: string; chain: string }) => /^[0-9a-f]{128}$/.test(s.sig) && /^[0-9a-f]{64}$/.test(s.chain)));
  });
});
