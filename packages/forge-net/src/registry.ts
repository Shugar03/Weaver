// S30 — ForgeRegistry: estado vivo de forges remotos (ADR-0005).
// Un forge solo "existe" mientras heartbeatea: TTL 15s, sin heartbeat expira
// y sale de rotación — la muerte por desconexión es el default.
// Cada ModelInstance reportada produce UN ForgeView (forgeId = instanceId);
// un rig con 3 instancias aparece como 3 views con el mismo forgePubkey.
import type { ForgeView } from "@weaver/scheduler";
import type { InstanceReport } from "./protocol.ts";
import type { ForgeStore } from "./store.ts";

export const HEARTBEAT_TTL_MS = 15_000;
// RTT declarado default para remotos (localhost dev); el ws-server lo pisa
// con el RTT medido por ping/pong cuando tiene muestra.
const DEFAULT_REMOTE_RTT_MS = 50;

type Session = {
  pubkey: string;
  lastSeen: number;
  instances: InstanceReport[];
  attested: Set<string>; // instanceIds que pasaron el benchmark
  rttMs?: number; // medido por ping/pong (ws-server lo escribe)
};

export class ForgeRegistry {
  private readonly sessions = new Map<string, Session>();
  private readonly store?: ForgeStore;
  private readonly now: () => number;

  constructor(store?: ForgeStore, now: () => number = Date.now) {
    this.store = store;
    this.now = now;
  }

  // auth OK → sesión registrada. Idempotente (re-auth tras reconexión).
  async register(pubkey: string): Promise<void> {
    const prev = this.sessions.get(pubkey);
    this.sessions.set(pubkey, {
      pubkey,
      lastSeen: this.now(),
      instances: prev?.instances ?? [],
      attested: prev?.attested ?? new Set(),
      rttMs: prev?.rttMs,
    });
    await this.store?.upsert({ pubkey }).catch(() => {});
  }

  unregister(pubkey: string): void {
    this.sessions.delete(pubkey);
  }

  // Heartbeat sin registro → false (el ws-server fuerza re-auth/close).
  heartbeat(pubkey: string, instances: InstanceReport[]): boolean {
    const s = this.sessions.get(pubkey);
    if (!s) return false;
    // instanceId único POR FORGE: si el daemon repite id, el último gana
    // (dedup honesto — dos slots con el mismo id romperían el routing).
    const dedup = new Map<string, InstanceReport>();
    for (const i of instances) dedup.set(i.instanceId, i);
    // instanceId es handle global de routing: si OTRO forge ya lo reclama,
    // esta instance no entra (colisión honesta, no routing ambiguo).
    s.instances = [...dedup.values()].filter((i) => !this.claimedByOther(i.instanceId, pubkey));
    s.lastSeen = this.now();
    void this.store?.touch(pubkey, s.lastSeen).catch(() => {});
    return true;
  }

  private claimedByOther(instanceId: string, pubkey: string): boolean {
    for (const [pk, s] of this.sessions) {
      if (pk !== pubkey && s.instances.some((i) => i.instanceId === instanceId)) return true;
    }
    return false;
  }

  setRtt(pubkey: string, rttMs: number): void {
    const s = this.sessions.get(pubkey);
    if (s) s.rttMs = rttMs;
  }

  // Attestation: el gateway marca la instance tras el benchmark OK.
  attest(pubkey: string, instanceId: string): void {
    this.sessions.get(pubkey)?.attested.add(instanceId);
    void this.store?.setAttested(pubkey, true).catch(() => {});
  }

  isAttested(pubkey: string, instanceId: string): boolean {
    return this.sessions.get(pubkey)?.attested.has(instanceId) ?? false;
  }

  // Payout: instanceId → pubkey del forge dueño (identidad = address).
  pubkeyOf(instanceId: string): string | undefined {
    for (const s of this.sessions.values()) {
      if (s.instances.some((i) => i.instanceId === instanceId)) return s.pubkey;
    }
    return undefined;
  }

  sessionsAlive(): string[] {
    return [...this.sessions.keys()];
  }

  // Último reporte de una instance — alimenta resident() del RemoteForgeExec
  // (el forge declara hot/cold de su engine local, medido por resident()).
  reportOf(instanceId: string): InstanceReport | undefined {
    for (const s of this.sessions.values()) {
      const r = s.instances.find((i) => i.instanceId === instanceId);
      if (r) return r;
    }
    return undefined;
  }

  // Expira sesiones sin heartbeat. Devuelve pubkeys removidos (para cerrar sockets).
  expire(): string[] {
    const t = this.now();
    const dead: string[] = [];
    for (const [pk, s] of this.sessions) {
      if (t - s.lastSeen > HEARTBEAT_TTL_MS) {
        this.sessions.delete(pk);
        dead.push(pk);
      }
    }
    return dead;
  }

  // Cada instance viva → un ForgeView. queueMs/inFlight/saturated/tokPerSec
  // los decora serve.ts (inFlight medido gateway-side por TrackedExec); el
  // heartbeat es la fuente cuando el exec no corrió todavía.
  views(): ForgeView[] {
    const out: ForgeView[] = [];
    for (const s of this.sessions.values()) {
      for (const i of s.instances) {
        out.push({
          forgeId: i.instanceId,
          model: i.model,
          hot: i.hot,
          rttMs: s.rttMs ?? DEFAULT_REMOTE_RTT_MS,
          queueMs: 0, // lo calcula serve.ts: inFlight × expected
          loadTimeMs: i.loadTimeMs,
          price: i.price ?? 0,
          reliability: 1, // placeholder hasta S36 (reliability medida)
          capability: i.capability,
          inFlight: i.inFlight,
          saturated: i.saturated,
          tokPerSec: i.tokPerSec,
          forgePubkey: s.pubkey,
          attested: s.attested.has(i.instanceId),
          remote: true,
        });
      }
    }
    return out;
  }
}
