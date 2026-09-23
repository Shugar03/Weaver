// S32 — ForgeSession: la conexión de UN forge remoto, lado gateway.
// Socket-agnóstica: recibe strings crudos (onRaw), emite strings (send) —
// el adapter ws del composition root hace la conversión. Testeable puro.
//
// Ciclo: auth (firma del nonce con su keypair) → register en el registry →
// heartbeats → views. Muerte: socket close / auth fail / frame inválido →
// unregister + close listeners (los RemoteExecs con jobs en vuelo fallan
// explícito, no cuelgan).
import type { ForgeMsg, GatewayMsg } from "./protocol.ts";
import { decode, encode } from "./protocol.ts";
import type { ForgeRegistry } from "./registry.ts";
import type { ForgeChannel } from "./remote.ts";

// Firma del forge sobre el nonce (bytes utf8 del nonce, firma hex).
export type VerifyFn = (pubkey: string, msg: Buffer, sig: Buffer) => boolean;

export class ForgeSession implements ForgeChannel {
  private readonly msgListeners = new Set<(m: ForgeMsg) => void>();
  private readonly closeListeners = new Set<() => void>();
  private readonly sendRaw: (raw: string) => void;
  private readonly requestClose: () => void;
  private readonly registry: ForgeRegistry;
  private readonly verify: VerifyFn;
  private readonly consumeNonce: (nonce: string) => boolean;
  private readonly authTimer: ReturnType<typeof setTimeout>;
  private alive = true;
  private authed = false;
  private _pubkey: string | null = null;
  // S50: rate-limit de heartbeats — el intervalo legítimo es ~5s; frames a
  // <500ms son flood (parse + registry churn gratis para el atacante).
  // Se dropea sin tocar el registry; 5 violaciones seguidas = kill (abuso
  // de protocolo, no latencia de red). job.*/pong no se limitan — los
  // bursts de resultados son trabajo legítimo.
  private lastHbAt = 0;
  private hbViolations = 0;
  private static readonly HB_MIN_MS = 500;
  private static readonly HB_MAX_VIOLATIONS = 5;

  constructor(deps: {
    send: (raw: string) => void;
    requestClose: () => void;
    registry: ForgeRegistry;
    verify: VerifyFn;
    consumeNonce: (nonce: string) => boolean;
    authTimeoutMs?: number;
    onAuthed?: (session: ForgeSession) => void;
  }) {
    this.sendRaw = deps.send;
    this.requestClose = deps.requestClose;
    this.registry = deps.registry;
    this.verify = deps.verify;
    this.consumeNonce = deps.consumeNonce;
    this.authTimer = setTimeout(() => {
      if (!this.authed) this.kill("auth timeout");
    }, deps.authTimeoutMs ?? 5_000);
    this.authTimer.unref?.();
    this.onAuthed = deps.onAuthed;
  }
  private readonly onAuthed?: (s: ForgeSession) => void;

  get pubkey(): string | null {
    return this._pubkey;
  }

  async onRaw(raw: string): Promise<void> {
    if (!this.alive) return;
    const m = decode(raw);
    if (!m) return this.kill("frame inválido");
    if (!this.authed) {
      if (m.type !== "auth") return this.kill("auth requerido");
      // Orden importa: consumeNonce primero (single-use), firma después.
      // Firma inválida consume el nonce igual — el forge reintenta con otro.
      const ok =
        this.consumeNonce(m.nonce) &&
        this.verify(m.pubkey, Buffer.from(m.nonce, "utf8"), Buffer.from(m.signature, "hex"));
      if (!ok) {
        this.send({ type: "auth.fail", error: "firma o nonce inválido" });
        return this.kill("auth fail");
      }
      this.authed = true;
      this._pubkey = m.pubkey;
      clearTimeout(this.authTimer);
      await this.registry.register(m.pubkey);
      this.send({ type: "auth.ok", pubkey: m.pubkey });
      this.onAuthed?.(this);
      return;
    }
    switch (m.type) {
      case "heartbeat": {
        const now = Date.now();
        if (now - this.lastHbAt < ForgeSession.HB_MIN_MS) {
          if (++this.hbViolations >= ForgeSession.HB_MAX_VIOLATIONS) return this.kill("heartbeat flood");
          return; // dropeado: el registry no se entera del flood
        }
        this.lastHbAt = now;
        this.hbViolations = 0;
        if (!this.registry.heartbeat(this._pubkey!, m.instances)) this.kill("heartbeat sin registro");
        break;
      }
      case "pong":
        this.registry.setRtt(this._pubkey!, Date.now() - m.t);
        break;
      case "auth":
        return this.kill("doble auth");
      default:
        for (const cb of this.msgListeners) cb(m); // job.*/image.* → remote execs
    }
  }

  send(msg: GatewayMsg): void {
    if (this.alive) this.sendRaw(encode(msg));
  }

  ping(): void {
    this.send({ type: "ping", t: Date.now() });
  }

  onMessage(cb: (m: ForgeMsg) => void): () => void {
    this.msgListeners.add(cb);
    return () => this.msgListeners.delete(cb);
  }

  onClose(cb: () => void): () => void {
    this.closeListeners.add(cb);
    return () => this.closeListeners.delete(cb);
  }

  isAlive(): boolean {
    return this.alive;
  }

  // Muerte real del socket (adapter la llama) o kill interno por protocolo.
  closed(): void {
    if (!this.alive) return;
    this.alive = false;
    clearTimeout(this.authTimer);
    if (this._pubkey) this.registry.unregister(this._pubkey);
    for (const cb of this.closeListeners) cb();
  }

  private kill(reason: string): void {
    void reason;
    this.closed();
    this.requestClose();
  }
}
