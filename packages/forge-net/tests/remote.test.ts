// S31 — RemoteForgeExec sobre ForgeChannel fake: semántica idéntica al exec
// local (chunks, proof del wire, onForge al primer token) y fallos honestos.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { RemoteForgeExec, RemoteImageExec, type ForgeChannel } from "../src/remote.ts";
import type { ExecRequest, ImageRequest, StreamChunk } from "@weaver/forge-exec";
import { commitProof, promptHashOf } from "@weaver/forge-exec";
import type { ForgeMsg, GatewayMsg } from "../src/protocol.ts";

class FakeChannel implements ForgeChannel {
  sent: GatewayMsg[] = [];
  private cbs = new Set<(m: ForgeMsg) => void>();
  private closeCbs = new Set<() => void>();
  alive = true;
  send(m: GatewayMsg) {
    this.sent.push(m);
  }
  onMessage(cb: (m: ForgeMsg) => void) {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }
  onClose(cb: () => void) {
    this.closeCbs.add(cb);
    return () => this.closeCbs.delete(cb);
  }
  isAlive() {
    return this.alive;
  }
  // helpers de test: el "daemon" emite frames
  emit(m: ForgeMsg) {
    for (const cb of this.cbs) cb(m);
  }
  close() {
    this.alive = false;
    for (const cb of this.closeCbs) cb();
  }
  lastAssign() {
    return this.sent.find((m) => m.type === "job.assign");
  }
}

const req = (over: Partial<ExecRequest> = {}): ExecRequest => ({
  jobId: "j1",
  model: "qwen3:4b",
  prompt: "hola",
  ...over,
});

const drain = async (it: AsyncIterable<StreamChunk>) => {
  const out: StreamChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
};

describe("S31 RemoteForgeExec", () => {
  it("assign → ack → chunks → done: stream completo + proof del wire", async () => {
    const ch = new FakeChannel();
    const ex = new RemoteForgeExec({ channel: ch, instanceId: "gpu0", model: "qwen3:4b" });
    let forged = "";
    let proof: { forgeId: string; resultHash: Buffer; signature: Buffer } | null = null;
    const it = ex.execute(req({ onForge: (f) => (forged = f), onProof: (p) => (proof = p) }));
    const realHash = createHash("sha256").update("hola mundo", "utf8").digest("hex");
    setTimeout(() => {
      ch.emit({ type: "job.ack", jobId: "j1" });
      ch.emit({ type: "job.chunk", jobId: "j1", token: "hola" });
      ch.emit({ type: "job.chunk", jobId: "j1", token: " mundo", kind: "content" });
      ch.emit({ type: "job.done", jobId: "j1", resultHash: realHash, signature: "bb".repeat(65), stats: { genTokens: 2 } });
    }, 10);
    const chunks = await drain(it);
    assert.equal(chunks.map((c) => c.token).join(""), "hola mundo");
    assert.equal(chunks.at(-1)?.done, true);
    assert.equal(chunks.at(-1)?.stats?.genTokens, 2);
    assert.equal(forged, "gpu0");
    assert.equal(proof!.resultHash.toString("hex"), realHash);
    const assign = ch.lastAssign();
    assert.equal(assign?.type, "job.assign");
    assert.equal(assign && "instanceId" in assign && assign.instanceId, "gpu0");
  });

  it("assign sin ack → throw pre-token (el failover reintenta en otro forge)", async () => {
    const ch = new FakeChannel();
    const ex = new RemoteForgeExec({ channel: ch, instanceId: "gpu0", model: "m", ackTimeoutMs: 30 });
    await assert.rejects(() => drain(ex.execute(req())), /assign sin ack/);
  });

  it("job.fail sin tokens → throw pre-token; midStream → propaga explícito", async () => {
    const ch = new FakeChannel();
    const ex = new RemoteForgeExec({ channel: ch, instanceId: "gpu0", model: "m" });
    const it = ex.execute(req());
    setTimeout(() => {
      ch.emit({ type: "job.ack", jobId: "j1" });
      ch.emit({ type: "job.chunk", jobId: "j1", token: "parcial" });
      ch.emit({ type: "job.fail", jobId: "j1", error: "boom mid-stream", midStream: true });
    }, 10);
    await assert.rejects(async () => {
      const seen: string[] = [];
      for await (const c of it) seen.push(c.token); // recibe lo parcial, luego error
      assert.ok(seen.includes("parcial"));
    }, /boom mid-stream/);
  });

  it("close del canal con job en vuelo → throw explícito (no cuelga)", async () => {
    const ch = new FakeChannel();
    const ex = new RemoteForgeExec({ channel: ch, instanceId: "gpu0", model: "m" });
    const it = ex.execute(req());
    setTimeout(() => {
      ch.emit({ type: "job.ack", jobId: "j1" });
      ch.emit({ type: "job.chunk", jobId: "j1", token: "x" });
      ch.close();
    }, 10);
    await assert.rejects(() => drain(it), /desconectado/);
  });

  it("S42: resultHash que no matchea los chunks → falla sin emitir proof (I1)", async () => {
    const ch = new FakeChannel();
    const ex = new RemoteForgeExec({ channel: ch, instanceId: "gpu0", model: "m" });
    let proof: unknown = null;
    const it = ex.execute(req({ onProof: (p) => (proof = p) }));
    setTimeout(() => {
      ch.emit({ type: "job.ack", jobId: "j1" });
      ch.emit({ type: "job.chunk", jobId: "j1", token: "basura servida" });
      // El daemon firma el hash de OTRA cosa — el proof no prueba lo servido.
      ch.emit({ type: "job.done", jobId: "j1", resultHash: createHash("sha256").update("respuesta hermosa").digest("hex"), signature: "cc".repeat(65) });
    }, 10);
    await assert.rejects(() => drain(it), /proof hash mismatch/);
    assert.equal(proof, null); // sin proof → no hay settle: no cobra lo que no sirvió
  });

  it("S42: hash correcto tras chunks vacíos/parciales → proof emitido", async () => {
    const ch = new FakeChannel();
    const ex = new RemoteForgeExec({ channel: ch, instanceId: "gpu0", model: "m" });
    let proof: { resultHash: Buffer } | null = null;
    const it = ex.execute(req({ onProof: (p) => (proof = p) }));
    const h = createHash("sha256").update("abc").digest("hex");
    setTimeout(() => {
      ch.emit({ type: "job.ack", jobId: "j1" });
      ch.emit({ type: "job.chunk", jobId: "j1", token: "a" });
      ch.emit({ type: "job.chunk", jobId: "j1", token: "bc" });
      ch.emit({ type: "job.done", jobId: "j1", resultHash: h, signature: "dd".repeat(65) });
    }, 10);
    await drain(it);
    assert.equal(proof!.resultHash.toString("hex"), h);
  });

  it("chunks think no entran al hash verificado — el gateway excluye razonamiento", async () => {
    // Regresión del fix content-only: el daemon excluye kind:think del hash;
    // si el gateway los incluyera, todo forge thinking fallaría verify.
    const ch = new FakeChannel();
    const ex = new RemoteForgeExec({ channel: ch, instanceId: "gpu0", model: "m" });
    let proof: { resultHash: Buffer } | null = null;
    const it = ex.execute(req({ onProof: (p) => (proof = p) }));
    const h = createHash("sha256").update("respuesta", "utf8").digest("hex");
    setTimeout(() => {
      ch.emit({ type: "job.ack", jobId: "j1" });
      ch.emit({ type: "job.chunk", jobId: "j1", token: "pensando…", kind: "think" });
      ch.emit({ type: "job.chunk", jobId: "j1", token: "respuesta", kind: "content" });
      ch.emit({ type: "job.done", jobId: "j1", resultHash: h, signature: "dd".repeat(65) });
    }, 10);
    const chunks = await drain(it);
    assert.equal(chunks.map((c) => c.token).join(""), "pensando…respuesta");
    assert.equal(proof!.resultHash.toString("hex"), h);
  });

  it("commitment era: promptHash+outputHash → firma ata input+output servido", async () => {
    const ch = new FakeChannel();
    const ex = new RemoteForgeExec({ channel: ch, instanceId: "gpu0", model: "qwen3:4b" });
    let proof: { resultHash: Buffer; promptHash?: Buffer; outputHash?: Buffer } | null = null;
    const it = ex.execute(req({ onProof: (p) => (proof = p) }));
    const pH = promptHashOf({ model: "qwen3:4b", prompt: "hola" });
    const oH = createHash("sha256").update("ok", "utf8").digest();
    const commit = commitProof(pH, oH);
    setTimeout(() => {
      ch.emit({ type: "job.ack", jobId: "j1" });
      ch.emit({ type: "job.chunk", jobId: "j1", token: "ok", kind: "content" });
      ch.emit({
        type: "job.done",
        jobId: "j1",
        resultHash: commit.toString("hex"),
        promptHash: pH.toString("hex"),
        outputHash: oH.toString("hex"),
        signature: "ee".repeat(65),
      });
    }, 10);
    await drain(it);
    assert.equal(proof!.resultHash.toString("hex"), commit.toString("hex"));
    assert.equal(proof!.promptHash?.toString("hex"), pH.toString("hex"));
    assert.equal(proof!.outputHash?.toString("hex"), oH.toString("hex"));
  });

  it("forge declara promptHash de OTRO input → proof rechazado (ata al despachado)", async () => {
    const ch = new FakeChannel();
    const ex = new RemoteForgeExec({ channel: ch, instanceId: "gpu0", model: "qwen3:4b" });
    let proof: unknown = null;
    const it = ex.execute(req({ onProof: (p) => (proof = p) }));
    // El forge hashea un input que NO es el que el gateway le mandó.
    const pH = promptHashOf({ model: "qwen3:4b", prompt: "otro prompt inventado" });
    const oH = createHash("sha256").update("ok", "utf8").digest();
    setTimeout(() => {
      ch.emit({ type: "job.ack", jobId: "j1" });
      ch.emit({ type: "job.chunk", jobId: "j1", token: "ok", kind: "content" });
      ch.emit({
        type: "job.done",
        jobId: "j1",
        resultHash: commitProof(pH, oH).toString("hex"),
        promptHash: pH.toString("hex"),
        outputHash: oH.toString("hex"),
        signature: "ee".repeat(65),
      });
    }, 10);
    await assert.rejects(() => drain(it), /proof hash mismatch/);
    assert.equal(proof, null);
  });

  it("probe = canal vivo; resident = reporte inyectado", async () => {
    const ch = new FakeChannel();
    const ex = new RemoteForgeExec({ channel: ch, instanceId: "gpu0", model: "m", resident: () => false });
    assert.equal(await ex.probe(), true);
    assert.equal(await ex.resident(), false);
    ch.close();
    assert.equal(await ex.probe(), false);
  });

  it("chunks y done con jobId ajeno son ignorados por completo (anti-spoof)", async () => {
    const ch = new FakeChannel();
    const ex = new RemoteForgeExec({ channel: ch, instanceId: "gpu0", model: "m" });
    const it = ex.execute(req({ jobId: "target-job" }));
    const realHash = createHash("sha256").update("contenido legitimo").digest("hex");
    setTimeout(() => {
      // frames de otro job
      ch.emit({ type: "job.ack", jobId: "alien-job" });
      ch.emit({ type: "job.chunk", jobId: "alien-job", token: "intruso" });
      ch.emit({ type: "job.done", jobId: "alien-job", resultHash: "00".repeat(32), signature: "11".repeat(65) });

      // frames del job legítimo
      ch.emit({ type: "job.ack", jobId: "target-job" });
      ch.emit({ type: "job.chunk", jobId: "target-job", token: "contenido legitimo" });
      ch.emit({ type: "job.done", jobId: "target-job", resultHash: realHash, signature: "22".repeat(65) });
    }, 10);
    const chunks = await drain(it);
    assert.equal(chunks.map((c) => c.token).join(""), "contenido legitimo");
    assert.equal(chunks.at(-1)?.done, true);
  });

  it("chunks recibidos post-done no alteran el stream ni reabren la ejecución", async () => {
    const ch = new FakeChannel();
    const ex = new RemoteForgeExec({ channel: ch, instanceId: "gpu0", model: "m" });
    const it = ex.execute(req({ jobId: "j-post-done" }));
    const h = createHash("sha256").update("hola").digest("hex");
    setTimeout(() => {
      ch.emit({ type: "job.ack", jobId: "j-post-done" });
      ch.emit({ type: "job.chunk", jobId: "j-post-done", token: "hola" });
      ch.emit({ type: "job.done", jobId: "j-post-done", resultHash: h, signature: "33".repeat(65) });
      // chunk tardío post-done
      ch.emit({ type: "job.chunk", jobId: "j-post-done", token: "tardio" });
    }, 10);
    const chunks = await drain(it);
    assert.equal(chunks.map((c) => c.token).join(""), "hola");
    assert.equal(chunks.length, 2); // 1 token chunk + 1 done chunk
    assert.equal(chunks[1].done, true);
  });

  it("firma malformada (hex truncado) → job falla sin emitir proof", async () => {
    // Sin el guard, un sig hex basura viajaba al escrow y el release
    // revertía on-chain — gas gastado por un recibo inválido.
    const ch = new FakeChannel();
    const ex = new RemoteForgeExec({ channel: ch, instanceId: "gpu0", model: "m" });
    let proof: unknown = null;
    const it = ex.execute(req({ onProof: (p) => (proof = p) }));
    const h = createHash("sha256").update("ok").digest("hex");
    setTimeout(() => {
      ch.emit({ type: "job.ack", jobId: "j1" });
      ch.emit({ type: "job.chunk", jobId: "j1", token: "ok" });
      ch.emit({ type: "job.done", jobId: "j1", resultHash: h, signature: "aabb" }); // 2 bytes — inválida
    }, 10);
    await assert.rejects(() => drain(it), /firma malformada/);
    assert.equal(proof, null);
  });

  it("job.done duplicado no reabre ni re-emite proof", async () => {
    const ch = new FakeChannel();
    const ex = new RemoteForgeExec({ channel: ch, instanceId: "gpu0", model: "m" });
    let proofs = 0;
    const it = ex.execute(req({ onProof: () => proofs++ }));
    const h = createHash("sha256").update("uno").digest("hex");
    const h2 = createHash("sha256").update("unoDOS").digest("hex");
    setTimeout(() => {
      ch.emit({ type: "job.ack", jobId: "j1" });
      ch.emit({ type: "job.chunk", jobId: "j1", token: "uno" });
      ch.emit({ type: "job.done", jobId: "j1", resultHash: h, signature: "aa".repeat(65) });
      // done duplicado — ni chunks tardíos ni receipts dobles.
      ch.emit({ type: "job.done", jobId: "j1", resultHash: h2, signature: "bb".repeat(65) });
      ch.emit({ type: "job.chunk", jobId: "j1", token: "DOS" });
    }, 10);
    const chunks = await drain(it);
    assert.equal(chunks.map((c) => c.token).join(""), "uno");
    assert.equal(proofs, 1);
  });

  it("resume mid-stream: el assign lleva resume.prefix y el commitment lo ata", async () => {
    const ch = new FakeChannel();
    const ex = new RemoteForgeExec({ channel: ch, instanceId: "gpu1", model: "qwen3:4b" });
    let proof: { resultHash: Buffer } | null = null;
    const it = ex.execute(
      req({
        resume: { prefix: "el forge muerto dijo: " },
        onProof: (p) => (proof = p),
      }),
    );
    // El forge honesto hashea {model, messages, resume:prefix} + su sufijo.
    const pH = promptHashOf({
      model: "qwen3:4b",
      prompt: "hola",
      resume: "el forge muerto dijo: ",
    });
    const oH = createHash("sha256").update("continuación", "utf8").digest();
    setTimeout(() => {
      ch.emit({ type: "job.ack", jobId: "j1" });
      ch.emit({ type: "job.chunk", jobId: "j1", token: "continuación", kind: "content" });
      ch.emit({
        type: "job.done",
        jobId: "j1",
        resultHash: commitProof(pH, oH).toString("hex"),
        promptHash: pH.toString("hex"),
        outputHash: oH.toString("hex"),
        signature: "ff".repeat(65),
      });
    }, 10);
    await drain(it);
    assert.ok(proof);
    const assign = ch.lastAssign();
    assert.equal(
      assign && "resume" in assign && (assign.resume as { prefix: string }).prefix,
      "el forge muerto dijo: ",
    );
  });

  it("resume: forge que ignora el prefijo en su promptHash → proof rechazado", async () => {
    const ch = new FakeChannel();
    const ex = new RemoteForgeExec({ channel: ch, instanceId: "gpu1", model: "qwen3:4b" });
    let proof: unknown = null;
    const it = ex.execute(req({ resume: { prefix: "prefijo" }, onProof: (p) => (proof = p) }));
    // Hash SIN resume — el commitment no ata lo despachado → rechazo.
    const pH = promptHashOf({ model: "qwen3:4b", prompt: "hola" });
    const oH = createHash("sha256").update("x", "utf8").digest();
    setTimeout(() => {
      ch.emit({ type: "job.ack", jobId: "j1" });
      ch.emit({ type: "job.chunk", jobId: "j1", token: "x", kind: "content" });
      ch.emit({
        type: "job.done",
        jobId: "j1",
        resultHash: commitProof(pH, oH).toString("hex"),
        promptHash: pH.toString("hex"),
        outputHash: oH.toString("hex"),
        signature: "ff".repeat(65),
      });
    }, 10);
    await assert.rejects(() => drain(it), /proof hash mismatch/);
    assert.equal(proof, null);
  });

  it("job sin chunks (output vacío / preimagen vacía) rechaza y no emite proof", async () => {
    const ch = new FakeChannel();
    const ex = new RemoteForgeExec({ channel: ch, instanceId: "gpu0", model: "m" });
    let proof: unknown = null;
    const it = ex.execute(req({ onProof: (p) => (proof = p) }));
    const emptyHash = createHash("sha256").digest("hex");
    setTimeout(() => {
      ch.emit({ type: "job.ack", jobId: "j1" });
      ch.emit({ type: "job.done", jobId: "j1", resultHash: emptyHash, signature: "dd".repeat(65) });
    }, 10);
    await assert.rejects(() => drain(it), /output vacío/);
    assert.equal(proof, null);
  });
});

describe("S31 RemoteImageExec", () => {
  it("assign → image.result resuelve con b64+ms", async () => {
    const ch = new FakeChannel();
    const ex = new RemoteImageExec({ channel: ch, instanceId: "img0", model: "flux" });
    const p = ex.generateImage({ jobId: "im1", model: "flux", prompt: "un gato" } as ImageRequest);
    setTimeout(() => ch.emit({ type: "image.result", jobId: "im1", b64: "QUJD", ms: 15000 }), 10);
    const r = await p;
    assert.equal(r.b64, "QUJD");
    assert.equal(r.ms, 15000);
    assert.equal(r.forgeId, "img0");
    assert.equal(ch.sent[0].type, "image.assign");
  });

  it("job.fail → reject con el error del forge", async () => {
    const ch = new FakeChannel();
    const ex = new RemoteImageExec({ channel: ch, instanceId: "img0", model: "flux" });
    const p = ex.generateImage({ jobId: "im1", model: "flux", prompt: "x" } as ImageRequest);
    setTimeout(() => ch.emit({ type: "job.fail", jobId: "im1", error: "VRAM agotada", midStream: false }), 10);
    await assert.rejects(p, /VRAM agotada/);
  });
});
