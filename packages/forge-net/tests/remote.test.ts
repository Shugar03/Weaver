// S31 — RemoteForgeExec sobre ForgeChannel fake: semántica idéntica al exec
// local (chunks, proof del wire, onForge al primer token) y fallos honestos.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { RemoteForgeExec, RemoteImageExec, type ForgeChannel } from "../src/remote.ts";
import type { ExecRequest, ImageRequest, StreamChunk } from "@weaver/forge-exec";
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
      ch.emit({ type: "job.done", jobId: "j1", resultHash: realHash, signature: "bb".repeat(32), stats: { genTokens: 2 } });
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
      ch.emit({ type: "job.done", jobId: "j1", resultHash: createHash("sha256").update("respuesta hermosa").digest("hex"), signature: "cc".repeat(32) });
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
      ch.emit({ type: "job.done", jobId: "j1", resultHash: h, signature: "dd".repeat(32) });
    }, 10);
    await drain(it);
    assert.equal(proof!.resultHash.toString("hex"), h);
  });

  it("probe = canal vivo; resident = reporte inyectado", async () => {
    const ch = new FakeChannel();
    const ex = new RemoteForgeExec({ channel: ch, instanceId: "gpu0", model: "m", resident: () => false });
    assert.equal(await ex.probe(), true);
    assert.equal(await ex.resident(), false);
    ch.close();
    assert.equal(await ex.probe(), false);
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
