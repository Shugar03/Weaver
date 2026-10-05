// SSRF hardening de web_fetch — el check de host corre SOLO sobre la URL
// inicial pero redirect:"follow" pivota a hosts internos sin re-validar.
// IPv6: ULA/link-local/loopback/IPv4-mapped tampoco estaban bloqueados.
// Fetch stubeado: las respuestas las arma el test, sin red real.
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createAgentHost } from "../src/agent.ts";

const host = createAgentHost({ cwd: "/tmp" });
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Resp = { status: number; headers?: Record<string, string>; body?: string };
const stubFetch = (script: Resp[]): { calls: string[] } => {
  const calls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    calls.push(String(input));
    const r = script.shift();
    if (!r) throw new Error("fetch fuera de guion");
    return new Response(r.body ?? "", { status: r.status, headers: r.headers });
  }) as typeof fetch;
  return { calls };
};

describe("web_fetch SSRF", () => {
  it("redirect 302 → host bloqueado: NO sigue el pivot", async () => {
    const { calls } = stubFetch([
      { status: 302, headers: { location: "http://127.0.0.1:9/internal-secret" } },
    ]);
    const out = await host.call("web_fetch", { url: "https://evil.example.com/redir" });
    assert.match(out, /bloquead|redirección|interno/i);
    assert.equal(calls.length, 1); // jamás tocó el host del Location
  });

  it("redirect relativo en el MISMO host público sí sigue", async () => {
    const { calls } = stubFetch([
      { status: 301, headers: { location: "/final" } },
      { status: 200, body: "contenido real" },
    ]);
    const out = await host.call("web_fetch", { url: "https://example.com/start" });
    assert.match(out, /contenido real/);
    assert.equal(calls.length, 2);
    assert.match(calls[1], /example\.com\/final/);
  });

  it("IPv4-mapeado en IPv6 [::ffff:7f00:1] → bloqueado sin fetch", async () => {
    const { calls } = stubFetch([]);
    const out = await host.call("web_fetch", { url: "http://[::ffff:7f00:1]/" });
    assert.match(out, /bloquead|interno/i);
    assert.equal(calls.length, 0);
  });

  it("IPv6 ULA/link-local [fd00::]/[fe80::] → bloqueado sin fetch", async () => {
    const { calls } = stubFetch([]);
    assert.match(await host.call("web_fetch", { url: "http://[fd00::1]/" }), /bloquead|interno/i);
    assert.match(await host.call("web_fetch", { url: "http://[fe80::1]/" }), /bloquead|interno/i);
    assert.equal(calls.length, 0);
  });

  it("redirect a esquema no-http (data:) → rechazado", async () => {
    const { calls } = stubFetch([
      { status: 302, headers: { location: "data:text/html,<script>1</script>" } },
    ]);
    const out = await host.call("web_fetch", { url: "https://evil.example.com/d" });
    assert.match(out, /http\/https|esquema|bloquead/i);
    assert.equal(calls.length, 1);
  });

  it("loop de redirects → corta con error (máx 5 hops)", async () => {
    const { calls } = stubFetch(
      Array.from({ length: 8 }, () => ({ status: 302, headers: { location: "https://example.com/loop" } })),
    );
    const out = await host.call("web_fetch", { url: "https://example.com/loop" });
    assert.match(out, /redirect|demasiad/i);
    assert.ok(calls.length <= 6);
  });
});
