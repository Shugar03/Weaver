// tools/call auth — antes: anónimo ejecutaba TODAS las server-tools del host
// (run_command = comandos en la máquina del operador, mcp__* = side-effects
// desconocidos). Regla: no-readonly → keyOwner "operator"; readonly → abierto
// (rate-limited). JSON roto → 400 (antes throw → 500).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.ts";
import { InMemoryApiKeys } from "@weaver/api-keys";
import type { AgentHost } from "../src/agent.ts";

const forges = () => [];
const json = { "content-type": "application/json" };

// El gate deriva readonly del manifest — el stub lo declara explícito.
const host = (): AgentHost => ({
  manifest: async () => ({
    persona: null,
    skills: [],
    tools: [
      { type: "function", readonly: true, function: { name: "web_search", description: "", parameters: {} } },
      { type: "function", readonly: false, function: { name: "run_command", description: "", parameters: {} } },
    ],
    mcp: [],
  }),
  call: async (name) => `ok:${name}`,
  close: async () => {},
});

async function setup() {
  const keys = new InMemoryApiKeys();
  const op = await keys.issue("operator");
  const dev = await keys.issue("dev");
  return { keys, op, dev };
}

const call = (name: string, secret?: string, body?: string): RequestInit => ({
  method: "POST",
  headers: secret ? { ...json, authorization: `Bearer ${secret}` } : json,
  body: body ?? JSON.stringify({ name, arguments: {} }),
});

describe("tools/call auth + parse", () => {
  it("JSON malformado → 400 bad_json (no 500)", async () => {
    const { keys } = await setup();
    const app = createApp({ forges, apiKeys: keys, agent: host() });
    const res = await app.request("/v1/agent/tools/call", { method: "POST", headers: json, body: "{roto" });
    assert.equal(res.status, 400);
  });

  it("anónimo + run_command (readonly:false) → 403", async () => {
    const { keys } = await setup();
    const app = createApp({ forges, apiKeys: keys, agent: host() });
    const res = await app.request("/v1/agent/tools/call", call("run_command"));
    assert.equal(res.status, 403);
  });

  it("anónimo + mcp__fs__read_file → 403 (mcp siempre no-readonly)", async () => {
    const { keys } = await setup();
    const app = createApp({ forges, apiKeys: keys, agent: host() });
    const res = await app.request("/v1/agent/tools/call", call("mcp__fs__read_file"));
    assert.equal(res.status, 403);
  });

  it("key de cuenta (no-operador) + run_command → 403", async () => {
    const { keys, dev } = await setup();
    const app = createApp({ forges, apiKeys: keys, agent: host() });
    const res = await app.request("/v1/agent/tools/call", call("run_command", dev.secret));
    assert.equal(res.status, 403);
  });

  it("operador + run_command → 200", async () => {
    const { keys, op } = await setup();
    const app = createApp({ forges, apiKeys: keys, agent: host() });
    const res = await app.request("/v1/agent/tools/call", call("run_command", op.secret));
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()) as { result: string }, { result: "ok:run_command" });
  });

  it("anónimo + web_search (readonly) → 200 — herramientas de lectura abiertas", async () => {
    const { keys } = await setup();
    const app = createApp({ forges, apiKeys: keys, agent: host() });
    const res = await app.request("/v1/agent/tools/call", call("web_search"));
    assert.equal(res.status, 200);
  });

  it("tool desconocida → fail closed, no filtra al dispatcher", async () => {
    const { keys } = await setup();
    const app = createApp({ forges, apiKeys: keys, agent: host() });
    const res = await app.request("/v1/agent/tools/call", call("delete_everything"));
    assert.equal(res.status, 403);
  });
});
