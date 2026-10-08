// S47 e2e — stage-federation sobre wire real (spec 018, escenarios BDD):
// daemons stage-worker con stage-server TCP REAL + coordinator federado con
// PipelineExec REAL (tcpStageDial + simFront). El único sim es el CÓMPUTO —
// transporte, protocolo gateway, pool, heal y activaciones viajan de verdad.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import {
  startStack,
  upStageDaemon,
  upPipelineDaemon,
  untilAttested,
  chatRequest,
  readUntil,
  sleep,
  type Stack,
} from "./harness.ts";
import type { ForgeDaemon, StageServer } from "@weaver/forge";
import { tcpStageDial } from "@weaver/forge";

const stacks: Stack[] = [];
const daemons: ForgeDaemon[] = [];
const servers: StageServer[] = [];
after(() => {
  for (const d of daemons) d.stop();
  for (const s of servers) s.close();
  for (const s of stacks) s.close();
});

const untilStageWorkers = async (stack: Stack, n: number, ms = 5000): Promise<void> => {
  const t0 = Date.now();
  while (stack.registry.stageWorkers().filter((w) => w.live).length < n && Date.now() - t0 < ms) {
    await sleep(50);
  }
};

describe("S47 stage-federation wire e2e", () => {
  it("happy path: cadena de 2 stages + coordinator → tokens por activaciones reales", async () => {
    const stack = await startStack();
    stacks.push(stack);
    // Stages primero: el attest del coordinator YA consume la cadena.
    const s1 = await upStageDaemon(stack, "s1", [0, 40]);
    const s2 = await upStageDaemon(stack, "s2", [40, 80]);
    daemons.push(s1.daemon, s2.daemon);
    servers.push(s1.server, s2.server);
    await untilStageWorkers(stack, 2);

    const c = await upPipelineDaemon(stack, "c0", 80);
    daemons.push(c.daemon);
    await untilAttested(stack.registry, 1, 12_000); // attest = job real por la cadena

    const res = await chatRequest(stack.url, "a b c");
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /\[DONE\]/);
    // Los tokens atravesaron los DOS stage-servers por TCP: cada uno vio su
    // sesión y la cerró al terminar (no quedó KV zombie).
    assert.equal(s1.compute.sessions(), 0);
    assert.equal(s2.compute.sessions(), 0);
    // Y el body lleva los tokens del sim: "a b c " en los deltas.
    assert.match(body, /"a "/);
    // A4: el receipt lleva stageSigs VERIFICADAS — cada stage firmó su chain
    // con su keypair ed25519 real y el gateway chequeó endpoint→signer.
    const sigs = JSON.parse(body.split("\n").filter((l) => l.includes('"stageSigs"')).at(-1)!.slice(5)).weaver_proof.stageSigs;
    assert.equal(sigs.length, 2);
    assert.deepEqual(sigs.map((s: { endpoint: string }) => s.endpoint).sort(), [s1.endpoint, s2.endpoint].sort());
    assert.ok(sigs.every((s: { sig: string }) => /^[0-9a-f]{128}$/.test(s.sig))); // ed25519 hex
  });

  it("stage muere mid-job → stage.need → spare reemplaza → replay → job completa", async () => {
    const stack = await startStack();
    stacks.push(stack);
    // s1 lento (30ms/step) para que el job dure lo bastante para matarlo a
    // mitad. s3 = spare del mismo tramo — queda libre en el pool.
    const s1 = await upStageDaemon(stack, "s1", [0, 40], undefined, undefined, { stepDelayMs: 30 });
    const s2 = await upStageDaemon(stack, "s2", [40, 80]);
    const s3 = await upStageDaemon(stack, "s3", [0, 40]);
    daemons.push(s1.daemon, s2.daemon, s3.daemon);
    servers.push(s1.server, s2.server, s3.server);
    await untilStageWorkers(stack, 3);
    const c = await upPipelineDaemon(stack, "c0", 80);
    daemons.push(c.daemon);
    await untilAttested(stack.registry, 1, 15_000);

    // Job largo: 8 tokens × 2 stages × 30ms ≈ 500ms de ventana.
    const res = await chatRequest(stack.url, "a b c d e f g h");
    assert.equal(res.status, 200);
    // Espero el primer token por el wire — la cadena está corriendo.
    let acc = await readUntil(res, "", '"a ', 15_000);
    s1.server.close(); // stage muere A MITAD DEL JOB — sockets destruidos
    // El job debe completar igual: heal por stage.need/offer + replay.
    acc = await readUntil(res, acc, "[DONE]", 20_000);
    assert.match(acc, /\[DONE\]/);
    assert.ok(acc.includes('"h "') || acc.includes('"h"')); // el último token llegó
    // El spare recibió el REPLAY: su sesión de reemplazo procesó seqs
    // monotónicos desde 0 (la historia que el muerto ya había computado) —
    // dual attention cache del paper, no re-prefill del prompt.
    const porSesion = new Map<string, number[]>();
    for (const e of s3.compute.seenSeqs()) {
      const xs = porSesion.get(e.sessionId) ?? [];
      xs.push(e.seq);
      porSesion.set(e.sessionId, xs);
    }
    const healed = [...porSesion.values()].find((seqs) => seqs.length >= 3 && seqs[0] === 0 && seqs[1] === 1);
    assert.ok(healed, `esperaba sesión reemplazada con replay desde seq 0 — visto: ${JSON.stringify([...porSesion])}`);
    // A4 post-heal: el reemplazo firma SU sesión (el loan se actualizó por
    // replace → su pubkey es el que verifica); el muerto no firma nada.
    const sigLine = acc.split("\n").filter((l) => l.includes('"stageSigs"')).at(-1);
    assert.ok(sigLine, "el receipt debía traer stageSigs verificadas del tramo reemplazado");
    const sigs = JSON.parse(sigLine.slice(5)).weaver_proof.stageSigs;
    assert.deepEqual(sigs.map((s: { endpoint: string }) => s.endpoint).sort(), [s2.endpoint, s3.endpoint].sort());
  });

  it("B2 direct: activaciones stage→stage (sin relay) + heal por stage-cache", async () => {
    const stack = await startStack();
    stacks.push(stack);
    // En directo el tensor NO pasa por el coordinator: s1 forwardea a s2.
    // s1 lento para abrir la ventana del kill mid-job; s3 = spare del tramo.
    const s1 = await upStageDaemon(stack, "s1", [0, 40], undefined, undefined, { stepDelayMs: 30 });
    const s2 = await upStageDaemon(stack, "s2", [40, 80]);
    const s3 = await upStageDaemon(stack, "s3", [0, 40]);
    daemons.push(s1.daemon, s2.daemon, s3.daemon);
    servers.push(s1.server, s2.server, s3.server);
    await untilStageWorkers(stack, 3);
    const c = await upPipelineDaemon(stack, "c0", 80, undefined, undefined, undefined, "direct");
    daemons.push(c.daemon);
    await untilAttested(stack.registry, 1, 15_000);

    const res = await chatRequest(stack.url, "a b c d e f g h");
    assert.equal(res.status, 200);
    let acc = await readUntil(res, "", '"a ', 15_000);
    s1.server.close(); // s1 muere mid-job — K-1=0 → el coordinator replaya
    acc = await readUntil(res, acc, "[DONE]", 20_000);
    assert.match(acc, /\[DONE\]/);
    assert.ok(acc.includes('"h "') || acc.includes('"h"'));
    // El spare recibió el replay absorb del coordinator (K=0: el `injected`
    // del coordinator es la fuente — no hay stage previo) + los tokens nuevos.
    const porSesion = new Map<string, number[]>();
    for (const e of s3.compute.seenSeqs()) {
      const xs = porSesion.get(e.sessionId) ?? [];
      xs.push(e.seq);
      porSesion.set(e.sessionId, xs);
    }
    const healed = [...porSesion.values()].find((seqs) => seqs.length >= 2 && seqs[0] === 0);
    assert.ok(healed, `esperaba sesión reemplazada con replay — visto: ${JSON.stringify([...porSesion])}`);
    // Boundary cross-check post-heal: s3.outChain == s2.inChain — el gateway
    // probó que la frontera del tramo reemplazado viajó intacta (v2 sigs).
    const sigLine = acc.split("\n").filter((l) => l.includes('"stageSigs"')).at(-1);
    assert.ok(sigLine, "receipt sin stageSigs — boundary check debió pasar post-heal");
    const sigs = JSON.parse(sigLine.slice(5)).weaver_proof.stageSigs;
    assert.deepEqual(sigs.map((s: { endpoint: string }) => s.endpoint).sort(), [s2.endpoint, s3.endpoint].sort());
    // Y efectivamente la frontera verifica: out del tramo [0,40] == in del [40,80].
    const a = sigs.find((s: { blocks: number[] }) => s.blocks[0] === 0);
    const b = sigs.find((s: { blocks: number[] }) => s.blocks[0] === 40);
    assert.equal(a.outChain, b.inChain, "frontera rota: out_[0,40] ≠ in_[40,80]");
  });

  it("stage muere sin spare → stage.offer vacío → job falla honesto mid-stream", async () => {
    const stack = await startStack();
    stacks.push(stack);
    const s1 = await upStageDaemon(stack, "s1", [0, 40], undefined, undefined, { stepDelayMs: 30 });
    const s2 = await upStageDaemon(stack, "s2", [40, 80]);
    daemons.push(s1.daemon, s2.daemon);
    servers.push(s1.server, s2.server);
    await untilStageWorkers(stack, 2);
    const c = await upPipelineDaemon(stack, "c0", 80);
    daemons.push(c.daemon);
    await untilAttested(stack.registry, 1, 15_000);

    const res = await chatRequest(stack.url, "a b c d e f g h");
    assert.equal(res.status, 200);
    const acc = await readUntil(res, "", '"a ', 15_000);
    s1.server.close(); // muere y NO hay spare del tramo [0,40)
    const body = await readUntil(res, acc, '"error"', 20_000).catch(() => acc);
    // Offer vacío → PipelineExec lanza → job.fail → el cliente ve el error.
    assert.match(body, /error|sin reemplazo|stage/i);
    assert.doesNotMatch(body, /\[DONE\]/); // jamás fingió completar
  });

  it("coordinator sin stages disponibles → cadena null → forge-failed honesto", async () => {
    const stack = await startStack();
    stacks.push(stack);
    const c = await upPipelineDaemon(stack, "c0", 80);
    daemons.push(c.daemon);
    await sleep(600); // attest falló al menos una vez (acquire → null)
    const res = await chatRequest(stack.url, "a b");
    const body = await res.text();
    assert.match(body, /forge-failed|error/i);
    assert.doesNotMatch(body, /\[DONE\]/);
  });

  it("B1 auth: con secrets, el job completa via capabilities minteadas; un cliente TCP sin token es rechazado", async () => {
    const stack = await startStack();
    stacks.push(stack);
    const SECRET = "e2e-stage-secret";
    // Workers con auth: el daemon mintea ante stage.grant; el stage-server
    // verifica la capability antes de alocar sesión (fail closed).
    const s1 = await upStageDaemon(stack, "s1", [0, 40], undefined, undefined, { stageSecret: SECRET });
    const s2 = await upStageDaemon(stack, "s2", [40, 80], undefined, undefined, { stageSecret: SECRET });
    daemons.push(s1.daemon, s2.daemon);
    servers.push(s1.server, s2.server);
    await untilStageWorkers(stack, 2);

    // Un cliente TCP crudo SIN token: no abre sesión (fail, cero KV).
    const rogue = tcpStageDial(s1.endpoint);
    await assert.rejects(
      rogue.open({ jobId: "j-rogue", sessionId: "s-rogue", model: "qwen3.5:4b", blocks: [0, 40] }),
      /capability/,
    );
    assert.equal(s1.compute.sessions(), 0);
    rogue.dispose();

    const c = await upPipelineDaemon(stack, "c0", 80);
    daemons.push(c.daemon);
    await untilAttested(stack.registry, 1, 15_000); // attest ya usa capabilities reales

    const res = await chatRequest(stack.url, "a b c");
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /\[DONE\]/);
    assert.match(body, /"a "/);
    // stageSigs igual de verificadas — auth no rompe la atribución A4.
    const sigs = JSON.parse(body.split("\n").filter((l) => l.includes('"stageSigs"')).at(-1)!.slice(5)).weaver_proof.stageSigs;
    assert.equal(sigs.length, 2);
  });
});
