// E2E wire real (S45 sobre ADR-0005): dos daemons WS conectados al gateway
// completo — challenge REST → auth firmada (dualVerify real) → heartbeat →
// RemoteForgeExec → attest real → RoutedExec+Failover. El primer daemon muere
// mid-stream; el segundo recibe job.assign CON resume.prefix y su proof ata
// prefijo+sufijo. Nada stubeado salvo el engine local de cada daemon.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { serve } from "@hono/node-server";
import { createApp } from "@weaver/gateway";
import { attachForgeWS, type ForgeWS } from "@weaver/gateway/forgews";
import { ForgeRegistry, NonceStore } from "@weaver/forge-net";
import { RoutedExec } from "@weaver/forge-exec";
import { dualVerify, stellarKeypair } from "@weaver/settlement";
import type { ExecRequest, ForgeExec, StreamChunk } from "@weaver/forge-exec";
import { ForgeDaemon, connect, type ForgeConfig } from "@weaver/forge";

// Engine scripteado: A emite 2 tokens visibles y muere; B graba el resume que
// le llega y completa. Los jobs attest-* (los dispara el gateway) se sirven
// siempre — pasan la attestation real y la instance entra a routing.
class DiesMidStream implements ForgeExec {
  readonly forgeId = "aaa-primero";
  readonly model = "qwen3.5:4b";
  async *execute(req: ExecRequest): AsyncIterable<StreamChunk> {
    if (req.jobId.startsWith("attest-")) {
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
    if (!req.jobId.startsWith("attest-")) this.sawResume = req.resume;
    yield { token: "CCCC", done: false };
    yield { token: "", done: true, stats: { genTokens: 1, decodeMs: 5 } };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("E2E resume sobre daemon remoto real", () => {
  let fws: ForgeWS | null = null;
  let server: { close(): void } | null = null;
  const daemons: ForgeDaemon[] = [];
  after(() => {
    for (const d of daemons) d.stop();
    fws?.stop();
    server?.close();
  });

  it("daemon A muere mid-stream → B recibe resume.prefix y completa", async () => {
    const registry = new ForgeRegistry();
    const nonces = new NonceStore();
    // execs perezosos como serve.ts: el exec remoto aparece post-heartbeat.
    const liveExecs = new Proxy({} as Record<string, ForgeExec>, {
      get: (_t, k) => fws?.remoteExecs.get(k as string),
    });
    const exec = new RoutedExec({
      forges: async () => registry.views().filter((v) => (v.capability ?? "text") === "text" && v.attested !== false),
      execs: liveExecs,
      // Orden determinístico por instanceId: aaa-primero sirve primero.
      order: (_req, views) => [...views].sort((a, b) => a.forgeId.localeCompare(b.forgeId)),
    });
    const app = createApp({ forges: async () => registry.views(), exec, challenges: nonces, verifyProof: dualVerify });
    server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    fws = attachForgeWS(server as never, { registry, nonces, verify: dualVerify });
    await new Promise((r) => setTimeout(r, 50));
    const port = (server as unknown as { address(): { port: number } }).address().port;
    const gw = `http://127.0.0.1:${port}`;

    // Dos daemons REALES: challenge → WS → firma ed25519 → heartbeat.
    const b = new RecordsResume();
    const up = async (kp: { pubkey: string; secret: string; sign(m: Buffer): Buffer }, instanceId: string, engine: ForgeExec) => {
      const channel = await connect({
        gateway: gw, chain: "stellar", pubkey: kp.pubkey, secret: kp.secret, instances: [],
      } as ForgeConfig);
      const d = new ForgeDaemon({
        channel,
        instances: [{ instanceId, model: "qwen3.5:4b", capability: "text", exec: engine, maxConcurrent: 4, loadTimeMs: 0 }],
        sign: kp.sign,
        heartbeatMs: 60,
        probes: { idleMs: async () => null, vramUsedGb: async () => null },
      });
      d.start();
      daemons.push(d);
    };
    await up(stellarKeypair(), "aaa-primero", new DiesMidStream());
    await up(stellarKeypair(), "zzz-rescue", b);

    // Esperar attestation de ambos (jobs attest-* reales por el canal).
    const t0 = Date.now();
    while (registry.views().filter((v) => v.attested === true).length < 2 && Date.now() - t0 < 8000) {
      await sleep(50);
    }
    assert.equal(registry.views().filter((v) => v.attested).length, 2, "ambos attested");

    const res = await fetch(`${gw}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "qwen3.5:4b", messages: [{ role: "user", content: "hola" }], stream: true }),
    });
    assert.equal(res.status, 200);
    const text = await res.text();

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
