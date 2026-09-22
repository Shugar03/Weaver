// Agent host: capabilities server-side del Weaver Agent.
// El loop del agente vive en el browser, pero hay cosas que un browser no puede
// hacer: spawnear MCP servers (stdio), fetchear URLs arbitrarias (CORS) y leer
// skills del disco. Este módulo las hospeda y las expone como tools comunes:
//   GET /v1/agent/manifest → persona + índice de skills + tool defs
//   POST /v1/agent/tools/call → ejecuta una server-tool por nombre
// Convenciones:
// - tools MCP se namespackean mcp__<server>__<tool> y se declaran readonly:false
//   (side-effects ajenos: no podemos garantizar lectura → nunca van a modo Plan)
// - readonly:true = seguro para Plan; el cliente filtra, el servidor también
//   verifica si algún día se expone el flag por request.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { extractText as pdfExtractText } from "unpdf";
import mammoth from "mammoth";
import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type AgentToolDef = {
  type: "function";
  readonly: boolean;
  function: { name: string; description: string; parameters: Record<string, unknown> };
};
export type SkillInfo = { name: string; description: string };
// Estado por server MCP — la UI lo muestra en el rail (connected/failed/pending).
export type McpServerInfo = { name: string; status: "ok" | "failed" | "down"; tools: number };

export type AgentHost = {
  manifest(): Promise<{ persona: string | null; skills: SkillInfo[]; tools: AgentToolDef[]; mcp: McpServerInfo[] }>;
  call(name: string, args: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
};

// ---------- web_search ----------
// Brave si hay BRAVE_API_KEY (real API); si no, DuckDuckGo HTML (sin key,
// parseo mínimo). El seam queda declarado: cambiar provider es un env.

const DDG_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

async function webSearch(q: string): Promise<string> {
  const query = q.trim().slice(0, 300);
  if (!query) return "query vacío";
  const braveKey = process.env.BRAVE_API_KEY;
  try {
    if (braveKey) {
      const r = await fetch(
        `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=8`,
        { headers: { "x-subscription-token": braveKey, accept: "application/json" }, signal: AbortSignal.timeout(10_000) },
      );
      if (!r.ok) return `brave: http ${r.status}`;
      const j = (await r.json()) as { web?: { results?: { title?: string; url?: string; description?: string }[] } };
      const items = (j.web?.results ?? []).slice(0, 8);
      return items.length
        ? items.map((x, i) => `${i + 1}. ${x.title ?? ""}\n   ${x.url ?? ""}\n   ${x.description ?? ""}`).join("\n")
        : "sin resultados";
    }
    const r = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: { "user-agent": DDG_UA },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return `duckduckgo: http ${r.status}`;
    const html = await r.text();
    const items: string[] = [];
    // Resultados DDG html: <a class="result__a" href="//duckduckgo.com/l/?uddg=<urlenc>">título</a>
    // + snippet en <a class="result__snippet">. Regex acotada: no es parser general.
    const linkRe = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const snipRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    const links: { url: string; title: string }[] = [];
    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(html)) && links.length < 8) {
      const raw = m[1];
      const uddg = raw.match(/uddg=([^&]+)/);
      const url = uddg ? decodeURIComponent(uddg[1]) : raw;
      links.push({ url, title: stripTags(m[2]) });
    }
    const snips: string[] = [];
    while ((m = snipRe.exec(html)) && snips.length < 8) snips.push(stripTags(m[1]));
    for (let i = 0; i < links.length; i++) {
      items.push(`${i + 1}. ${links[i].title}\n   ${links[i].url}${snips[i] ? `\n   ${snips[i]}` : ""}`);
    }
    return items.length ? items.join("\n") : "sin resultados (DDG pudo haber rate-limited)";
  } catch (e) {
    return `web_search falló: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ---------- web_fetch ----------
// GET + HTML→texto. Guard SSRF mínimo: nada de metadata cloud ni loopback —
// el gateway corre en la máquina del operador, un URL trucho no debe pivotear
// a servicios internos. Cap de 1MB y texto truncado a 4000 chars.

const BLOCKED_HOST = /^(localhost|127\.|0\.0\.0\.0|169\.254\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1|.*\.local$)/i;

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

async function webFetch(url: string): Promise<string> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "url inválida";
  }
  if (!/^https?:$/.test(u.protocol)) return "solo http/https";
  if (BLOCKED_HOST.test(u.hostname)) return "host bloqueado (interno/loopback)";
  try {
    const r = await fetch(u, {
      headers: { "user-agent": DDG_UA, accept: "text/html,text/plain,application/json,*/*" },
      redirect: "follow",
      signal: AbortSignal.timeout(12_000),
    });
    if (!r.ok) return `http ${r.status}`;
    const buf = await r.arrayBuffer();
    if (buf.byteLength > 1_000_000) return "documento demasiado grande (>1MB)";
    const text = stripTags(new TextDecoder().decode(buf));
    return text.length > 4000 ? `${text.slice(0, 4000)}\n…[truncado ${text.length} chars]` : text || "(vacío)";
  } catch (e) {
    return `web_fetch falló: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ---------- skills ----------
// Skill = directorio con SKILL.md (frontmatter YAML mínimo: name/description).
// Progressive disclosure: el manifest lleva name+description al system prompt;
// load_skill devuelve el cuerpo completo solo cuando el modelo lo pide.

const FRONT = /^---\s*\n([\s\S]*?)\n---\s*\n?/;

async function scanSkills(dirs: string[]): Promise<{ list: (SkillInfo & { path: string })[] }> {
  const found = new Map<string, SkillInfo & { path: string }>();
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(dir, e, "SKILL.md");
      try {
        const raw = await readFile(p, "utf8");
        const fm = raw.match(FRONT)?.[1] ?? "";
        const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? e;
        const description = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "";
        if (!found.has(name)) found.set(name, { name, description, path: p });
      } catch {
        /* no es skill o no leíble: se ignora */
      }
    }
  }
  return { list: [...found.values()] };
}

// ---------- run_command ----------
// Exec tool real pero acotado. Sin shell: el string se tokeniza (quotes
// respetados) y se spawnea el binario directo — `;`, `|`, `>` quedan como args
// literales inertes, no hay chaining posible. Allowlist de binarios con
// subcomandos/flags permitidos; cwd fijado al repo del gateway; corre con los
// permisos del operador (es SU máquina — por eso es exec-only, jamás en Plan).

const CMD_ALLOW: Record<string, { sub?: Set<string>; deny?: RegExp }> = {
  ls: {}, cat: {}, head: {}, tail: {}, wc: {}, pwd: {}, date: {}, echo: {},
  uname: {}, df: {}, du: {}, jq: {}, rg: {}, grep: {}, which: {}, file: {},
  find: { deny: /^-(exec|execdir|ok|okdir|delete)$/ },
  git: {
    sub: new Set([
      "status", "diff", "log", "show", "branch", "blame", "ls-files",
      "rev-parse", "remote", "describe", "shortlog", "tag", "count-objects",
      "--version",
    ]),
  },
  pnpm: { sub: new Set(["test", "build", "lint", "run", "list", "why", "--version"]) },
  node: { deny: /^(-e|--eval|-p|--print|--interactive|-i)$/ },
  ollama: { sub: new Set(["list", "ls", "ps", "show", "--version"]) },
};

function tokenizeCmd(cmd: string): string[] | null {
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  for (const ch of cmd.trim()) {
    if (q) {
      if (ch === q) q = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") q = ch;
    else if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
    } else if (/[;&|<>`$\\]/.test(ch) || ch === "\n") return null; // metachars de shell: rechazo
    else cur += ch;
  }
  if (q) return null;
  if (cur) out.push(cur);
  return out.length ? out : null;
}

async function runCommand(cwd: string, cmd: string, timeoutMs: number): Promise<string> {
  const argv = tokenizeCmd(cmd);
  if (!argv) return "comando rechazado: metachars de shell no permitidos (sin shell = sin chaining)";
  const [bin, ...args] = argv;
  const spec = CMD_ALLOW[bin];
  if (!spec) return `binario no permitido: ${bin} — allowlist: ${Object.keys(CMD_ALLOW).join(", ")}`;
  if (spec.sub && (!args[0] || !spec.sub.has(args[0]))) {
    return `${bin}: subcomando no permitido — permitidos: ${[...spec.sub].join(", ")}`;
  }
  if (spec.deny && args.some((a) => spec.deny!.test(a))) {
    return `${bin}: flag peligroso en args`;
  }
  const timeout = Math.min(120_000, Math.max(1_000, timeoutMs || 30_000));
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/local/bin", HOME: homedir() },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const kill = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(`timeout ${timeout}ms — proceso matado\n${out.slice(-2000)}`);
    }, timeout);
    child.stdout.on("data", (d) => {
      if (out.length < 20_000) out += d.toString();
    });
    child.stderr.on("data", (d) => {
      if (err.length < 4_000) err += d.toString();
    });
    child.on("error", (e) => {
      clearTimeout(kill);
      resolve(`spawn falló: ${e.message}`);
    });
    child.on("close", (code) => {
      clearTimeout(kill);
      const body = (out + (err ? `\n[stderr]\n${err}` : "")).trim();
      resolve(`exit ${code ?? "?"}\n${body.slice(0, 8000)}${body.length > 8000 ? "\n…[truncado]" : ""}`);
    });
  });
}

// ---------- MCP ----------
// Config estilo Claude Desktop en weaver.mcp.json:
//   { "mcpServers": { "fs": { "command": "npx", "args": [...] } } }
// Conexión lazy: el primer manifest/call levanta los servers; uno roto degrada
// a "sin tools de ese server" sin voltear el host. Reintento con cooldown de
// 60s — un server misconfigurado no spawnea procesos en cada manifest poll.

type McpServerCfg = { command: string; args?: string[]; env?: Record<string, string> };
type McpState = {
  cfg: Record<string, McpServerCfg>;
  clients: Map<string, Client>;
  failed: Map<string, number>; // server → ts del último intento fallido
  toolCounts: Map<string, number>; // server → tools expuestas en el último manifest
};

async function loadMcpConfig(paths: string[]): Promise<Record<string, McpServerCfg>> {
  for (const p of paths) {
    try {
      const j = JSON.parse(await readFile(p, "utf8")) as { mcpServers?: Record<string, McpServerCfg> };
      if (j.mcpServers && typeof j.mcpServers === "object") return j.mcpServers;
    } catch {
      /* siguiente candidato */
    }
  }
  return {};
}

async function mcpConnect(name: string, cfg: McpServerCfg, st: McpState): Promise<Client | null> {
  const prev = st.clients.get(name);
  if (prev) return prev;
  const lastFail = st.failed.get(name) ?? 0;
  if (Date.now() - lastFail < 60_000) return null;
  try {
    const client = new Client({ name: "weaver-agent", version: "0.1.0" });
    const transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args ?? [],
      env: { ...process.env, ...(cfg.env ?? {}) } as Record<string, string>,
      stderr: "pipe",
    });
    await Promise.race([
      client.connect(transport),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout 15s")), 15_000)),
    ]);
    st.clients.set(name, client);
    return client;
  } catch {
    st.failed.set(name, Date.now());
    return null;
  }
}

// ---------- extracción de documentos ----------
// Upload de archivos → texto para el contexto del agente. El modelo solo ve
// texto: PDF/DOCX se extraen acá, nunca llega binario al prompt.

const DOC_MAX_CHARS = 8000; // protege el contexto (16k) — docs más largos se truncan
const TEXT_EXTS = new Set([
  "txt", "md", "markdown", "csv", "json", "log", "yaml", "yml", "xml", "toml",
  "ts", "tsx", "js", "jsx", "py", "rs", "go", "java", "c", "cpp", "h", "css", "html", "sql", "sh",
]);

function capDoc(text: string, name: string): string {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (clean.length <= DOC_MAX_CHARS) return clean;
  return `${clean.slice(0, DOC_MAX_CHARS)}\n\n[…truncado: ${name} tiene ${clean.length} chars, se muestran ${DOC_MAX_CHARS}]`;
}

export async function extractDocText(name: string, buf: Buffer): Promise<string> {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  if (TEXT_EXTS.has(ext)) return capDoc(buf.toString("utf8"), name);
  if (ext === "pdf") {
    const { text } = await pdfExtractText(new Uint8Array(buf), { mergePages: true });
    return capDoc(typeof text === "string" ? text : (text as string[]).join("\n"), name);
  }
  if (ext === "docx") {
    const r = await mammoth.extractRawText({ buffer: buf });
    return capDoc(r.value, name);
  }
  throw new Error(`formato no soportado: .${ext || "?"} (probá txt/md/pdf/docx/csv/json/código)`);
}

// ---------- host ----------

export function createAgentHost(opts: { cwd: string; env?: NodeJS.ProcessEnv; gatewayBase?: string }): AgentHost {
  const env = opts.env ?? process.env;
  const gw = opts.gatewayBase ?? `http://127.0.0.1:${Number(env.PORT ?? 3001)}`;
  const skillsDirs = [
    ...(env.WEAVER_SKILLS_DIR ? [env.WEAVER_SKILLS_DIR] : []),
    join(opts.cwd, "skills"),
    join(homedir(), ".config", "weaver", "skills"),
  ];
  const personaPaths = [
    ...(env.WEAVER_AGENT_MD ? [env.WEAVER_AGENT_MD] : []),
    join(opts.cwd, "AGENT.md"),
    join(homedir(), ".config", "weaver", "AGENT.md"),
  ];
  const mcpPaths = [
    ...(env.WEAVER_MCP_JSON ? [env.WEAVER_MCP_JSON] : []),
    join(opts.cwd, "weaver.mcp.json"),
    join(homedir(), ".config", "weaver", "mcp.json"),
  ];
  const mcp: McpState = { cfg: {}, clients: new Map(), failed: new Map(), toolCounts: new Map() };
  let mcpLoaded = false;

  const skillsCache = { at: 0, list: [] as (SkillInfo & { path: string })[] };
  const skills = async () => {
    // Rescan acotado: skills cambian raramente, readdir cada 30s es gratis.
    if (Date.now() - skillsCache.at > 30_000) {
      skillsCache.list = (await scanSkills(skillsDirs)).list;
      skillsCache.at = Date.now();
    }
    return skillsCache.list;
  };

  const persona = async (): Promise<string | null> => {
    for (const p of personaPaths) {
      try {
        const t = (await readFile(p, "utf8")).trim();
        if (t) return t;
      } catch {
        /* siguiente */
      }
    }
    return null;
  };

  const builtin: AgentToolDef[] = [
    {
      type: "function",
      readonly: true,
      function: {
        name: "web_search",
        description: "Busca en la web (Brave si hay API key, si no DuckDuckGo). Devuelve títulos, URLs y snippets.",
        parameters: {
          type: "object",
          properties: { query: { type: "string", description: "consulta de búsqueda" } },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      readonly: true,
      function: {
        name: "web_fetch",
        description: "Descarga una URL pública y devuelve su texto (HTML→texto, ~4000 chars máx).",
        parameters: {
          type: "object",
          properties: { url: { type: "string", description: "URL http/https" } },
          required: ["url"],
        },
      },
    },
    {
      type: "function",
      readonly: true,
      function: {
        name: "list_skills",
        description: "Lista las skills instaladas (nombre + descripción).",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      readonly: true,
      function: {
        name: "load_skill",
        description: "Carga el contenido completo de una skill por nombre (instrucciones detalladas para una tarea).",
        parameters: {
          type: "object",
          properties: { name: { type: "string", description: "nombre de la skill" } },
          required: ["name"],
        },
      },
    },
    {
      type: "function",
      readonly: true, // compute puro: no muta la red
      function: {
        name: "generate_image",
        description:
          "Genera una imagen real en la red Weaver (forge de difusión, job ruteado por el scheduler). Devuelve la URL del artefacto en /v1/media/. Un gen puede tardar ~1min si el modelo está COLD.",
        parameters: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "descripción de la imagen" },
            size: { type: "string", description: "WxH, default 512x512 (rápida); 1024x1024 tarda varios min" },
          },
          required: ["prompt"],
        },
      },
    },
    {
      type: "function",
      readonly: false,
      function: {
        name: "run_command",
        description:
          "Ejecuta un comando en la máquina del nodo (cwd = repo Weaver). Sin shell ni allowlist-escape: solo binarios permitidos (ls, cat, rg, git status/diff/log, pnpm test/build, node, ollama ps…). Timeout default 30s, máx 120s.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "comando completo, ej: 'git status --short'" },
            timeout_ms: { type: "number", description: "timeout en ms, default 30000, máx 120000" },
          },
          required: ["command"],
        },
      },
    },
  ];

  const mcpTools = async (): Promise<AgentToolDef[]> => {
    if (!mcpLoaded) {
      mcp.cfg = await loadMcpConfig(mcpPaths);
      mcpLoaded = true;
    }
    const out: AgentToolDef[] = [];
    for (const [srv, cfg] of Object.entries(mcp.cfg)) {
      const client = await mcpConnect(srv, cfg, mcp);
      if (!client) {
        mcp.toolCounts.set(srv, 0);
        continue;
      }
      try {
        const { tools } = await client.listTools();
        mcp.toolCounts.set(srv, tools.length);
        for (const t of tools) {
          out.push({
            type: "function",
            readonly: false, // side-effects desconocidos → jamás en Plan
            function: {
              name: `mcp__${srv}__${t.name}`.replace(/[^a-zA-Z0-9_-]/g, "_"),
              description: (t.description ?? `tool ${t.name} de ${srv}`).slice(0, 400),
              parameters: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
            },
          });
        }
      } catch {
        /* server cayó entre connect y listTools */
      }
    }
    return out;
  };

  return {
    async manifest() {
      const [p, sk, mt] = await Promise.all([persona(), skills(), mcpTools()]);
      return {
        persona: p,
        skills: sk.map(({ name, description }) => ({ name, description })),
        tools: [...builtin, ...mt],
        mcp: Object.keys(mcp.cfg).map((name) => ({
          name,
          status: mcp.clients.has(name) ? ("ok" as const) : mcp.failed.has(name) ? ("failed" as const) : ("down" as const),
          tools: mcp.toolCounts.get(name) ?? 0,
        })),
      };
    },

    async call(name, args) {
      if (name === "web_search") return webSearch(String(args.query ?? ""));
      if (name === "web_fetch") return webFetch(String(args.url ?? ""));
      if (name === "run_command") {
        return runCommand(opts.cwd, String(args.command ?? ""), Number(args.timeout_ms) || 30_000);
      }
      if (name === "generate_image") {
        // Loopback a la ruta ruteada: una sola fuente de verdad (scheduler + telemetría).
        const r = await fetch(`${gw}/v1/images/generations`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "flux2-klein-4b",
            prompt: String(args.prompt ?? "").slice(0, 2000),
            size: String(args.size ?? "512x512"),
          }),
          signal: AbortSignal.timeout(180_000), // COLD load + gen puede superar el minuto
        });
        if (!r.ok) return `generate_image: http ${r.status} ${(await r.text()).slice(0, 200)}`;
        const j = (await r.json()) as { data?: { url?: string }[]; weaver?: { forge?: string; ms?: number } };
        const url = j.data?.[0]?.url;
        if (!url) return "imagen generada pero sin media URL";
        return `imagen lista — media:${url} (forge ${j.weaver?.forge ?? "?"}, ${j.weaver?.ms ?? "?"}ms)`;
      }
      if (name === "list_skills") {
        const sk = await skills();
        return sk.length ? sk.map((s) => `- ${s.name}: ${s.description}`).join("\n") : "sin skills instaladas";
      }
      if (name === "load_skill") {
        const want = String(args.name ?? "");
        const s = (await skills()).find((x) => x.name === want);
        if (!s) return `skill inexistente: ${want}`;
        try {
          const raw = await readFile(s.path, "utf8");
          return raw.replace(FRONT, "").trim().slice(0, 8000);
        } catch {
          return `skill ${want} no leíble`;
        }
      }
      const m = name.match(/^mcp__([^_]+)__(.+)$/);
      if (m) {
        const client = await mcpConnect(m[1], mcp.cfg[m[1]], mcp);
        if (!client) return `server MCP ${m[1]} no disponible`;
        try {
          const r = await client.callTool({ name: m[2], arguments: args });
          const parts = (r.content as { type: string; text?: string }[]) ?? [];
          const text = parts
            .filter((p) => p.type === "text")
            .map((p) => p.text ?? "")
            .join("\n");
          return (text || JSON.stringify(r.content)).slice(0, 8000);
        } catch (e) {
          return `mcp ${name} falló: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      return `server-tool desconocida: ${name}`;
    },

    async close() {
      for (const c of mcp.clients.values()) await c.close().catch(() => {});
      mcp.clients.clear();
    },
  };
}
