// S33 — transporte real del daemon: challenge REST → WS → auth firmado →
// DaemonChannel sobre ws. Reconnect con backoff: la sesión expira por TTL
// del lado gateway, el daemon se re-registra solo (mining-pool semantics).
import WebSocket from "ws";
import { Keypair } from "@stellar/stellar-sdk";
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

// Una conexión autenticada. Falla (throw) si challenge/auth/ws fallan —
// el caller (connectLoop) decide el backoff.
export async function connect(cfg: ForgeConfig): Promise<DaemonChannel> {
  const keypair = Keypair.fromSecret(cfg.secret);
  const ch = await fetch(`${cfg.gateway}/v1/forges/challenge`, { method: "POST" });
  if (!ch.ok) throw new Error(`challenge ${ch.status}`);
  const { nonce } = (await ch.json()) as { nonce: string };

  const wsUrl = `${cfg.gateway.replace(/^http/, "ws")}/v1/forge/ws`;
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((res, rej) => {
    ws.once("open", res);
    ws.once("error", rej);
  });
  // Keypair.sign devuelve Uint8Array — Buffer.from antes de hex (sin eso
  // toString da "123,45,..." decimal, no hex: auth.fail silencioso).
  const signature = Buffer.from(keypair.sign(Buffer.from(nonce, "utf8"))).toString("hex");
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

// Loop de servicio: conecta → daemon corre → si el socket muere, backoff y
// re-auth (nonce nuevo). cancel() para shutdown limpio.
export function connectLoop(
  cfg: ForgeConfig,
  makeDaemon: (channel: DaemonChannel) => { start(): void; stop(): void },
  log: (msg: string) => void = console.log,
): { cancel(): void } {
  let cancelled = false;
  let current: { stop(): void } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const run = async () => {
    while (!cancelled) {
      try {
        const channel = await connect(cfg);
        log(`forge conectado a ${cfg.gateway} como ${cfg.pubkey.slice(0, 12)}…`);
        const d = makeDaemon(channel);
        current = d;
        d.start();
        await new Promise<void>((res) => channel.onClose(res));
        d.stop();
        current = null;
        if (!cancelled) log("conexión perdida — reintentando en 3s");
      } catch (e) {
        if (!cancelled) log(`connect falló: ${e instanceof Error ? e.message : e} — reintentando en 3s`);
      }
      if (!cancelled) {
        await new Promise<void>((r) => {
          timer = setTimeout(r, 3_000);
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
