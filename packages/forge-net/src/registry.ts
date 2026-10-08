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
  agentId?: number; // ERC-8004 (EVM) — reportado por el heartbeat (self-declared)
  agentVerified?: boolean; // ownerOf(agentId)==pubkey confirmado on-chain
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
  heartbeat(pubkey: string, instances: InstanceReport[], agentId?: number): boolean {
    const s = this.sessions.get(pubkey);
    if (!s) return false;
    // instanceId único POR FORGE: si el daemon repite id, el último gana
    // (dedup honesto — dos slots con el mismo id romperían el routing).
    const dedup = new Map<string, InstanceReport>();
    for (const i of instances) dedup.set(i.instanceId, i);
    // instanceId es handle global de routing: si OTRO forge ya lo reclama,
    // esta instance no entra (colisión honesta, no routing ambiguo).
    s.instances = [...dedup.values()].filter((i) => !this.claimedByOther(i.instanceId, pubkey));
    // Claim nuevo → la verificación anterior no aplica (un forge podría
    // reportar un agentId ajeno después de haber sido verificado con otro).
    if (agentId !== undefined && agentId !== s.agentId) s.agentVerified = false;
    if (agentId !== undefined) s.agentId = agentId;
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

  // Claims ERC-8004 pendientes de verificar on-chain (agentId sin owner check).
  agentClaims(): { pubkey: string; agentId: number }[] {
    const out: { pubkey: string; agentId: number }[] = [];
    for (const s of this.sessions.values()) {
      if (s.agentId !== undefined && s.agentVerified !== true) out.push({ pubkey: s.pubkey, agentId: s.agentId });
    }
    return out;
  }

  // Marca verificado SOLO si el claim sigue vivo (un heartbeat pudo cambiarlo
  // entre el ownerOf y este mark — la verificación vale para ese agentId).
  markAgentVerified(pubkey: string, agentId: number): boolean {
    const s = this.sessions.get(pubkey);
    if (!s || s.agentId !== agentId) return false;
    s.agentVerified = true;
    return true;
  }

  // agentId VERIFICADO del forge — la fuente confiable para feedback (el env
  // ERC8004_AGENTS sigue siendo override del operador).
  verifiedAgentId(pubkey: string): number | undefined {
    const s = this.sessions.get(pubkey);
    return s?.agentVerified === true ? s.agentId : undefined;
  }

  setRtt(pubkey: string, rttMs: number): void {
    const s = this.sessions.get(pubkey);
    if (s) s.rttMs = Number.isFinite(rttMs) ? Math.max(0, rttMs) : DEFAULT_REMOTE_RTT_MS;
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
  // rpc-worker NO es una ruta — es un recurso del pool (spec 017): queda
  // fuera del routing y de attestation; el pairing lo descubre vía workers().
  views(): ForgeView[] {
    const out: ForgeView[] = [];
    for (const s of this.sessions.values()) {
      for (const i of s.instances) {
        // Ni rpc-worker ni stage-worker son rutas: son recursos que el
        // gateway parkea (spec 017/018) — fuera del scheduler y attestation.
        if (i.capability === "rpc-worker" || i.capability === "stage-worker") continue;
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
          ...(s.agentId !== undefined
            ? { forgeAgentId: s.agentId, forgeAgentVerified: s.agentVerified === true }
            : {}),
        });
      }
    }
    return out;
  }

  // S46 pool-forge: rpc-workers vivos con su endpoint + dueño. El gateway
  // los empareja con coordinators pooled — endpoint solo viaja en el assign.
  // `live` = el daemon reporta el rpc-server arriba y no saturado.
  workers(): { instanceId: string; forgePubkey: string; endpoint: string; vramGb?: number; rttMs: number; live: boolean }[] {
    const out: { instanceId: string; forgePubkey: string; endpoint: string; vramGb?: number; rttMs: number; live: boolean }[] = [];
    for (const s of this.sessions.values()) {
      for (const i of s.instances) {
        if (i.capability !== "rpc-worker" || !i.rpc) continue;
        out.push({
          instanceId: i.instanceId,
          forgePubkey: s.pubkey,
          endpoint: i.rpc.endpoint,
          ...(i.rpc.vramGb !== undefined ? { vramGb: i.rpc.vramGb } : {}),
          rttMs: s.rttMs ?? DEFAULT_REMOTE_RTT_MS,
          live: i.hot && !i.saturated,
        });
      }
    }
    return out;
  }

  // S47 stage-federation: stage-workers vivos con rango de bloques + endpoint.
  // Recursos del StagePool — nunca rutas. `live` = stage-server arriba y con
  // lugar para otra sesión (KV disponible).
  stageWorkers(): {
    instanceId: string;
    forgePubkey: string;
    model: string;
    endpoint: string;
    layers: [number, number];
    tps?: number;
    rttMs: number;
    live: boolean;
  }[] {
    const out: {
      instanceId: string;
      forgePubkey: string;
      model: string;
      endpoint: string;
      layers: [number, number];
      tps?: number;
      rttMs: number;
      live: boolean;
    }[] = [];
    for (const s of this.sessions.values()) {
      for (const i of s.instances) {
        if (i.capability !== "stage-worker" || !i.stage) continue;
        out.push({
          instanceId: i.instanceId,
          forgePubkey: s.pubkey,
          model: i.model,
          endpoint: i.stage.endpoint,
          layers: i.stage.layers,
          ...(i.stage.tps !== undefined ? { tps: i.stage.tps } : {}),
          rttMs: s.rttMs ?? DEFAULT_REMOTE_RTT_MS,
          live: i.hot && !i.saturated,
        });
      }
    }
    return out;
  }
}
