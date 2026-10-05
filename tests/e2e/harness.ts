// Harness compartido para e2e de wire real: gateway completo (Hono app +
// attachForgeWS) + daemons conectados por connect() (challenge REST → auth
// ed25519 → heartbeat). Lo único scripteado es el engine local de cada daemon.
import { serve } from "@hono/node-server";
import { createApp } from "@weaver/gateway";
import { attachForgeWS, type ForgeWS } from "@weaver/gateway/forgews";
import { ForgeRegistry, NonceStore } from "@weaver/forge-net";
import { RoutedExec } from "@weaver/forge-exec";
import { dualVerify, stellarKeypair } from "@weaver/settlement";
import type { ExecRequest, ForgeExec } from "@weaver/forge-exec";
import type { ForgeView } from "@weaver/scheduler";
import { ForgeDaemon, connect, type ForgeConfig } from "@weaver/forge";

export type Stack = {
  url: string;
  registry: ForgeRegistry;
  fws: ForgeWS;
  close(): void;
};

// Orden por instanceId — determinístico, no depende de ping/ETR medido.
export function startStack(): Promise<Stack> {
  const registry = new ForgeRegistry();
  const nonces = new NonceStore();
  const box: { fws?: ForgeWS } = {};
  const liveExecs = new Proxy({} as Record<string, ForgeExec>, {
    get: (_t, k) => box.fws?.remoteExecs.get(k as string),
  });
  const exec = new RoutedExec({
    forges: async () =>
      registry.views().filter((v: ForgeView) => (v.capability ?? "text") === "text" && v.attested !== false),
    execs: liveExecs,
    order: (_req: ExecRequest, views: ForgeView[]) => [...views].sort((a, b) => a.forgeId.localeCompare(b.forgeId)),
  });
  const app = createApp({ forges: async () => registry.views(), exec, challenges: nonces, verifyProof: dualVerify });
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  const fws = attachForgeWS(server as never, { registry, nonces, verify: dualVerify });
  box.fws = fws;
  return new Promise((res) =>
    setTimeout(
      () =>
        res({
          url: `http://127.0.0.1:${(server as unknown as { address(): { port: number } }).address().port}`,
          registry,
          fws,
          close() {
            fws.stop();
            (server as unknown as { close(): void }).close();
          },
        }),
      50,
    ),
  );
}

// Daemon real por el wire: connect() hace challenge+auth contra el stack,
// ForgeDaemon corre el protocolo (heartbeats a 60ms para tests rápidos).
// Devuelve el keypair — el kill/reconnect necesita la MISMA pubkey.
export async function upDaemon(
  stack: Stack,
  instanceId: string,
  engine: ForgeExec,
  kp: { pubkey: string; secret: string; sign(m: Buffer): Buffer } = stellarKeypair(),
): Promise<{ daemon: ForgeDaemon; kp: typeof kp }> {
  const channel = await connect({
    gateway: stack.url, chain: "stellar", pubkey: kp.pubkey, secret: kp.secret, instances: [],
  } as ForgeConfig);
  const d = new ForgeDaemon({
    channel,
    instances: [{ instanceId, model: "qwen3.5:4b", capability: "text", exec: engine, maxConcurrent: 4, loadTimeMs: 0 }],
    sign: kp.sign,
    // 550ms > HB_MIN_MS(500) del session rate-limiter — a 60ms el daemon
    // comía flood-violations y la sesión moría por "heartbeat flood" ~300ms
    // después de conectar. El primer beat va inmediato igual.
    heartbeatMs: 550,
    probes: { idleMs: async () => null, vramUsedGb: async () => null },
  });
  d.start();
  return { daemon: d, kp };
}

// Los jobs attest-* los dispara el gateway al registrar la instance —
// los engines scripteados los sirven siempre para pasar la attestation real.
export const isAttest = (req: { jobId: string }): boolean => req.jobId.startsWith("attest-");

export const untilAttested = async (registry: ForgeRegistry, n: number, ms = 8000): Promise<void> => {
  const t0 = Date.now();
  while (registry.views().filter((v: ForgeView) => v.attested === true).length < n && Date.now() - t0 < ms) {
    await new Promise((r) => setTimeout(r, 50));
  }
};

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function chatRequest(url: string): Promise<Response> {
  return fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "qwen3.5:4b", messages: [{ role: "user", content: "hola" }], stream: true }),
  });
}

export async function chatStream(url: string): Promise<string> {
  const res = await chatRequest(url);
  return res.text();
}

// Lee el SSE hasta que el acumulado contenga `needle` — sincroniza contra lo
// que el CLIENTE ya recibió (no contra lo que el engine emitió localmente).
export async function readUntil(res: Response, acc: string, needle: string): Promise<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  while (!acc.includes(needle)) {
    const { done, value } = await reader.read();
    if (done) break;
    acc += dec.decode(value, { stream: true });
  }
  reader.releaseLock();
  return acc;
}
