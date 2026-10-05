// run_command sandbox — la allowlist de binarios no restringía PATHS:
// `cat ~/.ssh/id_rsa` o `find /etc` leían fuera del workspace del operador.
// Ahora: todo arg path-like de binarios PATHY debe resolver dentro de cwd,
// con realpath para cazar escapes por symlink.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentHost } from "../src/agent.ts";

// cwd = apps/gateway (tiene package.json real para los reads válidos)
const repoCwd = new URL("..", import.meta.url).pathname;
const host = createAgentHost({ cwd: repoCwd });
const run = (command: string) => host.call("run_command", { command });

describe("run_command path sandbox", () => {
  it("paths relativos dentro del workspace funcionan", async () => {
    const out = await run("cat package.json");
    assert.match(out, /"name"/); // leyó el package.json real
    assert.match(await run("ls src"), /index\.ts|agent\.ts/);
  });

  it("traversal con .. → rechazado", async () => {
    assert.match(await run("cat ../../etc/passwd"), /fuera del workspace/);
    assert.match(await run("ls ../.."), /fuera del workspace/);
  });

  it("path absoluto fuera → rechazado", async () => {
    assert.match(await run("cat /etc/passwd"), /fuera del workspace/);
    assert.match(await run("find /etc -name '*.conf'"), /fuera del workspace/);
    assert.match(await run("head -5 /var/log/system.log"), /fuera del workspace/);
  });

  it("grep con pattern + path: pattern no-flag ok, path fuera rechazado", async () => {
    const ok = await run(`grep -r runCommand src`);
    assert.match(ok, /runCommand/);
    assert.match(await run(`grep password /etc/passwd`), /fuera del workspace/);
  });

  it("symlink que apunta fuera → rechazado aunque resuelva lexicalmente adentro", async () => {
    const dir = mkdtempSync(join(tmpdir(), "weaver-sbx-"));
    writeFileSync(join(dir, "real.txt"), "contenido legal");
    mkdirSync(join(dir, "sub"));
    symlinkSync("/etc", join(dir, "sub", "escape"));
    const h = createAgentHost({ cwd: dir });
    assert.match(await h.call("run_command", { command: "cat sub/escape/passwd" }), /fuera del workspace|no existe|denied|error/i);
    assert.match(await h.call("run_command", { command: "cat real.txt" }), /contenido legal/);
    assert.match(await h.call("run_command", { command: "cat sub/../real.txt" }), /contenido legal/); // .. interno legal
  });

  it("node solo corre scripts del workspace; binarios sin paths intactos", async () => {
    assert.match(await run("node --version"), /v\d/);
    assert.match(await run("node /etc/passwd"), /fuera del workspace/);
    assert.match(await run("echo hola"), /hola/);
    assert.match(await run("pwd"), /gateway/);
  });
});
