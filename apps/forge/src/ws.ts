// S33 — transporte real del daemon: challenge REST → WS → auth firmado →
// DaemonChannel sobre ws. Reconnect con backoff: la sesión expira por TTL
// del lado gateway, el daemon se re-registra solo (mining-pool semantics).
import WebSocket from "ws";
import { Keypair } from "@stellar/stellar-sdk";
import { evmForgeKeypair } from "@weaver/settlement";
import type { Hex } from "viem";
import { decodeGateway, encode, type DaemonChannel, type ForgeMsg, type GatewayMsg } from "@weaver/forge-net";
import type { ForgeConfig } from "./config.ts";

class WsDaemonChannel implements DaemonChannel {
  private readonly ws: WebSocket;
  private readonly msgCbs = new Set<(m: GatewayMsg) => void>();
  private readonly closeCbs = new Set<() => void>();
  private alive = true;

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data) => {
      const m = decodeGateway(data.toString());
      if (m) for (const cb of this.msgCbs) cb(m);
    });
    const dead = () => {
      if (!this.alive) return;
      this.alive = false;
      for (const cb of this.closeCbs) cb();
    };
    ws.on("close", dead);
    ws.on("error", dead);
  }

  send(m: ForgeMsg): void {
    if (this.alive && this.ws.readyState === this.ws.OPEN) this.ws.send(encode(m));
  }
  onMessage(cb: (m: GatewayMsg) => void): () => void {
    this.msgCbs.add(cb);
    return () => this.msgCbs.delete(cb);
  }
  onClose(cb: () => void): () => void {
    this.closeCbs.add(cb);
    return () => this.closeCbs.delete(cb);
  }
  isAlive(): boolean {
    return this.alive;
  }
}

// Normaliza el gateway URL para cada transporte: http(s) para REST,
// ws(s) para el socket. Acepta http://, https://, ws:// y wss:// —
// `wss://` es el formato que la gente escribe naturalmente para TLS.
function gwUrls(gateway: string): { http: string; ws: string } {
  const http = gateway.replace(/^ws/, "http"); // ws→http, wss→https
  const ws = gateway.replace(/^http/, "ws"); // http→ws, https→wss
  return { http, ws };
}

// Una conexión autenticada. Falla (throw) si challenge/auth/ws fallan —
// el caller (connectLoop) decide el backoff.
export async function connect(cfg: ForgeConfig): Promise<DaemonChannel> {
  // Nonce-signer por chain: ed25519 (stellar) o personal_sign (evm, ADR-0008).
  // El gateway distingue por formato de pubkey (G… vs 0x…) — mismo wire.
  const signNonce: (msg: Buffer) => Promise<Buffer> =
    cfg.chain === "evm"
      ? evmForgeKeypair(cfg.secret as Hex).sign
      : async (msg) => Buffer.from(Keypair.fromSecret(cfg.secret).sign(msg));
  const urls = gwUrls(cfg.gateway);
  const ch = await fetch(`${urls.http}/v1/forges/challenge`, { method: "POST" });
  if (!ch.ok) throw new Error(`challenge ${ch.status}`);
  const { nonce } = (await ch.json()) as { nonce: string };

  const wsUrl = `${urls.ws}/v1/forge/ws`;
  // maxPayload 8MiB: un assign puede llevar contexto largo, pero un gateway
  // malicioso no puede DoSear el daemon con frames infinitos (default 100MiB).
  const ws = new WebSocket(wsUrl, { maxPayload: 8 * 1024 * 1024 });
  await new Promise<void>((res, rej) => {
    ws.once("open", res);
    ws.once("error", rej);
  });
  // Keypair.sign devuelve Uint8Array — Buffer.from antes de hex (sin eso
  // toString da "123,45,..." decimal, no hex: auth.fail silencioso).
  // EVM firma el mismo nonce utf8 como personal_sign (65 bytes).
  const signature = (await signNonce(Buffer.from(nonce, "utf8"))).toString("hex");
  const channel = new WsDaemonChannel(ws);
  ws.send(encode({ type: "auth", pubkey: cfg.pubkey, nonce, signature }));

  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error("auth timeout")), 5_000);
    const un = channel.onMessage((m) => {
      if (m.type === "auth.ok") {
        clearTimeout(t);
        un();
        res();
      } else if (m.type === "auth.fail") {
        clearTimeout(t);
        un();
        rej(new Error(`auth.fail: ${m.error}`));
      }
    });
    channel.onClose(() => rej(new Error("socket cerrado antes de auth")));
  });
  return channel;
}

// Backoff exponencial con jitter: 1s→2s→4s… cap 30s, ±50% random.
// Conexión que vivió >30s no cuenta como falla — un drop de una sesión
// sana resetea el contador (reconecta rápido); un gateway muerto o auth
// rechazado escala hasta el cap (sin martillar).
export function nextBackoff(failures: number, rand: () => number = Math.random): number {
  const base = Math.min(30_000, 1000 * 2 ** Math.min(failures, 5));
  return Math.round(base * (0.5 + rand()));
}

export function connectLoop(
  cfg: ForgeConfig,
  makeDaemon: (channel: DaemonChannel) => { start(): void; stop(): void },
  log: (msg: string) => void = console.log,
  deps: { connect?: typeof connect; rand?: () => number } = {},
): { cancel(): void } {
  const connectFn = deps.connect ?? connect;
  const rand = deps.rand ?? Math.random;
  let cancelled = false;
  let current: { stop(): void } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;

  const run = async () => {
    while (!cancelled) {
      try {
        const channel = await connectFn(cfg);
        log(`forge conectado a ${cfg.gateway} como ${cfg.pubkey.slice(0, 12)}…`);
        const d = makeDaemon(channel);
        current = d;
        d.start();
        const connectedAt = Date.now();
        await new Promise<void>((res) => channel.onClose(res));
        d.stop();
        current = null;
        // Sesión sana que cayó ≠ flapping: reset. Una que murió al toque
        // (auth ok + close inmediato, p.ej. kill-chaos) sí escala.
        failures = Date.now() - connectedAt > 30_000 ? 0 : failures + 1;
        if (!cancelled) log(`conexión perdida — reintento #${failures}`);
      } catch (e) {
        failures++;
        if (!cancelled) log(`connect falló: ${e instanceof Error ? e.message : e} — reintento #${failures}`);
      }
      if (!cancelled) {
        const wait = nextBackoff(failures, rand);
        await new Promise<void>((r) => {
          timer = setTimeout(r, wait);
        });
      }
    }
  };
  void run();
  return {
    cancel() {
      cancelled = true;
      if (timer) clearTimeout(timer);
      current?.stop();
    },
  };
}
