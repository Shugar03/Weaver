// Agent host: manifest + ejecución de server-tools. El host es un puerto —
// el test lo stubea; las implementaciones reales (web, MCP, disco) se verifican en vivo.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.ts";
import type { AgentHost } from "../src/agent.ts";

const forges = () => [];
const json = { "content-type": "application/json" };

const host = (over?: Partial<AgentHost>): AgentHost => ({
  manifest: async () => ({
    persona: "sos de prueba",
    skills: [{ name: "chaos-drill", description: "drill de failover" }],
    tools: [
      { type: "function", readonly: true, function: { name: "web_search", description: "busca", parameters: { type: "object" } } },
      { type: "function", readonly: false, function: { name: "mcp__fs__read_file", description: "lee", parameters: { type: "object" } } },
    ],
    mcp: [{ name: "fs", status: "ok" as const, tools: 14 }],
  }),
  call: async (name, args) => `ok:${name}:${JSON.stringify(args)}`,
  close: async () => {},
  ...over,
});

describe("agent host", () => {
  it("manifest expone persona, skills y tools con flag readonly", async () => {
    const app = createApp({ forges, agent: host() });
    const res = await app.request("/v1/agent/manifest");
    assert.equal(res.status, 200);
    const j = (await res.json()) as { persona: string; skills: unknown[]; tools: { readonly: boolean }[] };
    assert.equal(j.persona, "sos de prueba");
    assert.equal(j.skills.length, 1);
    assert.deepEqual(j.tools.map((t) => t.readonly), [true, false]);
  });

  it("manifest expone estado por server MCP", async () => {
    const app = createApp({ forges, agent: host() });
    const j = (await (await app.request("/v1/agent/manifest")).json()) as { mcp: { name: string; status: string; tools: number }[] };
    assert.deepEqual(j.mcp, [{ name: "fs", status: "ok", tools: 14 }]);
  });

  it("files: extrae texto de un .txt subido por multipart", async () => {
    const app = createApp({ forges, agent: host() });
    const form = new FormData();
    form.append("file", new File(["hola telar"], "nota.txt", { type: "text/plain" }));
    const res = await app.request("/v1/agent/files", { method: "POST", body: form });
    assert.equal(res.status, 200);
    const j = (await res.json()) as { name: string; chars: number; text: string };
    assert.equal(j.name, "nota.txt");
    assert.equal(j.text, "hola telar");
  });

  it("files: extensión no soportada → 422 honesto", async () => {
    const app = createApp({ forges, agent: host() });
    const form = new FormData();
    form.append("file", new File(["MZ..."], "virus.exe", { type: "application/octet-stream" }));
    const res = await app.request("/v1/agent/files", { method: "POST", body: form });
    assert.equal(res.status, 422);
    assert.match((await res.json()).error, /no soportado/);
  });

  it("files: sin campo file → 400", async () => {
    const app = createApp({ forges, agent: host() });
    const res = await app.request("/v1/agent/files", { method: "POST", body: new FormData() });
    assert.equal(res.status, 400);
  });

  it("tools/call delega por nombre con arguments", async () => {
    const app = createApp({ forges, agent: host() });
    const res = await app.request("/v1/agent/tools/call", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ name: "web_search", arguments: { query: "stellar" } }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { result: 'ok:web_search:{"query":"stellar"}' });
  });

  it("tools/call sin name → 400", async () => {
    const app = createApp({ forges, agent: host() });
    const res = await app.request("/v1/agent/tools/call", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ arguments: {} }),
    });
    assert.equal(res.status, 400);
  });

  it("sin agent en deps → rutas no existen", async () => {
    const app = createApp({ forges });
    assert.equal((await app.request("/v1/agent/manifest")).status, 404);
  });
});
