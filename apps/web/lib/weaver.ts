// Cliente HTTP Weaver para el dashboard. Lee gateway vivo o falla honesto.
// Los Server Components usan getForges/readJson; los Client usan runChat/setKill.
export type ForgeView = {
  forgeId: string;
  model: string;
  hot: boolean;
  rttMs: number;
  queueMs: number;
  loadTimeMs: number;
  price: number;
  reliability: number;
  sim?: boolean;
  capability?: "text" | "image"; // ausente = text (default del gateway)
  // S29: carga real medida — jobs corriendo ahora / llegó al cap del gateway.
  inFlight?: number;
  saturated?: boolean;
  // S30/S35: forge remoto por WS (keypair propia) + attestation del gateway.
  remote?: boolean;
  attested?: boolean;
};

export type JobsDecision = { forge: string; etr_ms: number; reason: string };

export type RunStatus =
  | "idle"
  | "connecting"
  | "forge-selected"
  | "streaming"
  | "completed"
  | "error";

export async function getForges(base: string): Promise<ForgeView[] | null> {
  try {
    const r = await fetch(`${base}/v1/forges`, { cache: "no-store" });
    if (!r.ok) return null;
    return (await r.json()) as ForgeView[];
  } catch {
    return null;
  }
}

export async function postJobs(base: string, model: string): Promise<JobsDecision> {
  const r = await fetch(`${base}/v1/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model }),
  });
  if (!r.ok) throw new Error(`jobs: http ${r.status}`);
  return (await r.json()) as JobsDecision;
}

export function operatorKey(): string | null {
  try {
    return localStorage.getItem("weaver:operator-key");
  } catch {
    return null;
  }
}

export function saveOperatorKey(key: string): void {
  try {
    localStorage.setItem("weaver:operator-key", key);
  } catch {
    /* sin storage: se pide cada vez */
  }
}

export async function setKill(base: string, dead: boolean, forgeId?: string): Promise<void> {
  const key = operatorKey();
  const r = await fetch(`${base}/v1/admin/kill`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({ dead, ...(forgeId ? { forgeId } : {}) }),
  });
  if (!r.ok) throw new Error(`kill: http ${r.status}`);
}

// ---------- SSE compartido ----------

type ChatDelta = {
  role?: string;
  content?: string;
  reasoning?: string;
  tool_calls?: RawToolCall[];
};
type RawToolCall = {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
};

type StreamEvent =
  | { type: "delta"; delta: ChatDelta }
  | { type: "finish"; reason: string; usage?: { prompt_tokens?: number; completion_tokens?: number } }
  | { type: "error"; error: string };

// Un request → stream de frames ya parseados. Lo comparten runChat (dashboard,
// un solo hop) y runAgent (loop de tools multi-hop).
async function* streamChat(base: string, body: Record<string, unknown>): AsyncGenerator<StreamEvent> {
  let res: Response;
  try {
    res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("gateway caído — levantá :3001");
  }
  if (!res.ok || !res.body) throw new Error(`chat: http ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buf += dec.decode(value, { stream: !done });
    for (;;) {
      const i = buf.indexOf("\n\n");
      if (i < 0) break;
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of frame.split("\n")) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const data = t.slice(5).trim();
        if (data === "[DONE]") return;
        let json: {
          error?: string;
          detail?: string; // causa real del error (OOM/evicción/timeout)
          usage?: { prompt_tokens?: number; completion_tokens?: number };
          choices?: { delta?: ChatDelta; finish_reason?: string | null }[];
        };
        try {
          json = JSON.parse(data) as typeof json;
        } catch {
          continue;
        }
        if (typeof json.error === "string" && json.error) {
          // detail = causa real (OOM/evicción/timeout) si el gateway la mandó.
          yield { type: "error", error: json.detail ? `${json.error}: ${json.detail}` : json.error };
          return;
        }
        const ch = json.choices?.[0];
        if (ch?.delta && Object.keys(ch.delta).length > 0) yield { type: "delta", delta: ch.delta };
        if (ch?.finish_reason) yield { type: "finish", reason: ch.finish_reason, usage: json.usage };
      }
    }
    if (done) return;
  }
}

export type RunCallbacks = {
  onStatus: (s: RunStatus, detail?: string) => void;
  onToken: (t: string) => void;
  // Razonamiento del modelo (qwen3 thinking): llega como delta.reasoning —
  // el UI que lo implementa lo muestra; el que no, no lo pierde del stream.
  onReasoning?: (t: string) => void;
  onDone: (meta: { forge: string; ttftMs: number; etrMs: number; reason: string }) => void;
  onError: (msg: string) => void;
};

// Pipeline honesto: decisión del scheduler + stream real, EN PARALELO.
// El /v1/jobs solo informa qué forge eligió el scheduler para mostrarlo; el
// chat rutea internamente igual. Serializarlos sumaba un RTT al TTFT percibido.
export async function runChat(base: string, model: string, prompt: string, cb: RunCallbacks): Promise<void> {
  cb.onStatus("connecting");
  const decisionP = postJobs(base, model).catch(() => null);
  const t0 = performance.now();
  let first = -1;
  let text = "";
  try {
    void decisionP.then((d) => {
      if (d) cb.onStatus("forge-selected", d.forge);
    });
    for await (const ev of streamChat(base, {
      model,
      messages: [{ role: "user", content: prompt }],
      stream: true,
    })) {
      if (ev.type === "delta") {
        const { reasoning, content } = ev.delta;
        if (reasoning) {
          if (first < 0) {
            first = performance.now();
            cb.onStatus("streaming");
          }
          cb.onReasoning?.(reasoning);
        }
        if (content) {
          if (first < 0) {
            first = performance.now();
            cb.onStatus("streaming");
          }
          text += content;
          cb.onToken(content);
        }
      } else if (ev.type === "error") {
        throw new Error(ev.error);
      }
    }
    const decision = await decisionP;
    cb.onDone({
      forge: decision?.forge ?? "desconocido",
      ttftMs: Math.round(first < 0 ? performance.now() - t0 : first - t0),
      etrMs: decision?.etr_ms ?? 0,
      reason: decision?.reason ?? "sin-decisión",
    });
    return;
  } catch (e) {
    void text;
    cb.onError(e instanceof Error ? e.message : "error de red");
  }
}

// ---------- Agente: tools + memoria ----------

export type ToolDef = {
  type: "function";
  readonly?: boolean; // ausente = client-side (ya acotado por modo); presente = server-tool
  function: { name: string; description: string; parameters: Record<string, unknown> };
};
export type ToolCall = { name: string; arguments: Record<string, unknown> };
export type AgentMessage = {
  role: string;
  content: string;
  tool_calls?: unknown[];
  name?: string;
};
export type AgentCallbacks = RunCallbacks & {
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  // Resultado crudo del tool (texto que vuelve al modelo) — la UI lo usa para
  // detectar artefactos (media:/v1/media/<id>) y renderizarlos inline.
  onToolResult?: (name: string, result: string) => void;
  // Uso real del engine por hop (prompt_tokens incluye system+historial+tools):
  // alimenta el medidor de contexto con números medidos, no estimados.
  onUsage?: (promptTokens: number, completionTokens: number) => void;
};

// ---------- Agent host: capabilities server-side ----------

export type AgentManifest = {
  persona: string | null;
  skills: { name: string; description: string }[];
  tools: ToolDef[];
  // Estado por server MCP configurado — el rail lo muestra (ok/failed/down).
  mcp?: { name: string; status: "ok" | "failed" | "down"; tools: number }[];
};

// Una llamada al montar: persona (AGENT.md del nodo), índice de skills y las
// server-tools (web_search, web_fetch, mcp__*). Falla → el agente sigue solo
// con sus tools locales; el manifest es mejora, no requisito.
export async function fetchAgentManifest(base: string): Promise<AgentManifest | null> {
  try {
    const r = await fetch(`${base}/v1/agent/manifest`, { cache: "no-store" });
    if (!r.ok) return null;
    return (await r.json()) as AgentManifest;
  } catch {
    return null;
  }
}

// Upload de documento → texto extraído server-side (pdf/docx/txt/código).
// Devuelve el texto que el modelo va a ver — el binario nunca entra al contexto.
export async function uploadDoc(
  base: string,
  file: File,
): Promise<{ name: string; chars: number; text: string }> {
  const form = new FormData();
  form.append("file", file);
  const r = await fetch(`${base}/v1/agent/files`, { method: "POST", body: form });
  const j = (await r.json()) as { name?: string; chars?: number; text?: string; error?: string };
  if (!r.ok || !j.text) throw new Error(j.error ?? `http ${r.status}`);
  return { name: j.name ?? file.name, chars: j.chars ?? j.text.length, text: j.text };
}

// Estimador de contexto para el medidor: ~4 chars/token (regla estándar) +
// overhead por mensaje y por tool schema. El número real llega por onUsage
// después de cada hop — esto es solo para lo que todavía no se mandó.
export function estimateContextTokens(messages: AgentMessage[], tools: ToolDef[]): number {
  let chars = 0;
  for (const m of messages) chars += m.content.length + 16;
  for (const t of tools) chars += t.function.name.length + t.function.description.length + 80;
  return Math.ceil(chars / 4);
}

// Memoria local del agente (ZDR: vive en el device del usuario, jamás en el nodo).
const MEM_KEY = "weaver:agent:memory";
const MEM_MAX = 24;

export function loadMemory(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(MEM_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function saveMemory(list: string[]): void {
  try {
    localStorage.setItem(MEM_KEY, JSON.stringify(list.slice(-MEM_MAX)));
  } catch {
    /* lleno: la sesión sigue */
  }
}

// Catálogo: el agente inspecciona y opera SU propia red — el diferencial Weaver.
export const AGENT_TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "list_forges",
      description: "Lista la fleet Weaver: forgeId, modelo, estado HOT/COLD, ETR medido (ms), precio y reliability.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "route_check",
      description: "Pregunta al scheduler qué forge elegiría para un modelo dado y por qué (ETR, razón).",
      parameters: {
        type: "object",
        properties: { model: { type: "string", description: "modelo a routear, ej qwen3:4b" } },
        required: ["model"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "network_usage",
      description: "Uso del nodo gateway: jobs totales, ok, tasa de éxito y gasto acumulado en USDC.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "recent_executions",
      description: "Últimas ejecuciones reales: forge que sirvió, TTFT medido en ms, ok, timestamp.",
      parameters: {
        type: "object",
        properties: { limit: { type: "number", description: "máx 50, default 5" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "kill_forge",
      description: "Mata un forge (chaos switch). Sin forgeId = el primario; el próximo request hace failover — la red sobrevive.",
      parameters: {
        type: "object",
        properties: { forgeId: { type: "string", description: "id del forge a matar (default: primario)" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "revive_forge",
      description: "Revive un forge tras kill_forge. Sin forgeId = el primario.",
      parameters: {
        type: "object",
        properties: { forgeId: { type: "string", description: "id del forge a revivir (default: primario)" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remember",
      description: "Guarda un hecho sobre el usuario en memoria local persistente (sobrevive entre sesiones, solo en este dispositivo).",
      parameters: {
        type: "object",
        properties: { fact: { type: "string", description: "hecho a recordar, una línea" } },
        required: ["fact"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "forget",
      description: "Borra memoria local: todas las entradas, o una por índice (0-based).",
      parameters: {
        type: "object",
        properties: { index: { type: "number", description: "índice a borrar; omitir = borrar todo" } },
      },
    },
  },
];

// Subconjunto read-only para modo PLAN.
export const PLAN_TOOLS = AGENT_TOOLS.filter((t) =>
  ["list_forges", "route_check", "network_usage", "recent_executions"].includes(t.function.name),
);

async function readJson(res: Response): Promise<unknown> {
  if (!res.ok) throw new Error(`http ${res.status}`);
  return res.json();
}

// Ejecutor real: las tools locales pegan contra el MISMO gateway que sirve al
// agente; las server-tools (web_search, web_fetch, load_skill, mcp__*) se
// delegan al agent host vía /v1/agent/tools/call — el browser no puede
// spawnear procesos ni fetchear URLs arbitrarias.
// Errores vuelven como texto al modelo (puede reintentar o explicar), jamás throw.
export function makeToolExecutor(
  base: string,
  serverTools?: Set<string>,
): (name: string, args: Record<string, unknown>) => Promise<string> {
  return async (name, args) => {
    try {
      if (serverTools?.has(name) || name.startsWith("mcp__")) {
        const r = await fetch(`${base}/v1/agent/tools/call`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name, arguments: args }),
        });
        if (!r.ok) return `server-tool ${name}: http ${r.status}`;
        const j = (await r.json()) as { result?: string };
        return j.result ?? "(sin resultado)";
      }
      switch (name) {
        case "list_forges": {
          const f = await getForges(base);
          return f ? JSON.stringify(f) : "gateway sin respuesta";
        }
        case "route_check":
          return JSON.stringify(await postJobs(base, typeof args.model === "string" ? args.model : "qwen3:4b"));
        case "network_usage":
          return JSON.stringify(await readJson(await fetch(`${base}/v1/usage`, { cache: "no-store" })));
        case "recent_executions": {
          const n = Math.min(50, Math.max(1, Number(args.limit) || 5));
          return JSON.stringify(await readJson(await fetch(`${base}/v1/executions?limit=${n}`, { cache: "no-store" })));
        }
        case "kill_forge": {
          const id = typeof args.forgeId === "string" && args.forgeId ? args.forgeId : undefined;
          await setKill(base, true, id);
          return `forge ${id ?? "primario"} muerto — el próximo request hace failover`;
        }
        case "revive_forge": {
          const id = typeof args.forgeId === "string" && args.forgeId ? args.forgeId : undefined;
          await setKill(base, false, id);
          return `forge ${id ?? "primario"} revivido`;
        }
        case "remember": {
          const fact = typeof args.fact === "string" ? args.fact.trim() : "";
          if (!fact) return "nada que recordar";
          const mem = loadMemory();
          if (!mem.includes(fact)) saveMemory([...mem, fact]);
          return `recordado (${loadMemory().length} hechos en memoria)`;
        }
        case "forget": {
          const mem = loadMemory();
          if (typeof args.index === "number" && mem[args.index] !== undefined) {
            mem.splice(args.index, 1);
            saveMemory(mem);
            return `borrada — quedan ${mem.length}`;
          }
          saveMemory([]);
          return "memoria borrada por completo";
        }
        default:
          return `tool desconocida: ${name}`;
      }
    } catch (e) {
      return `error ejecutando ${name}: ${e instanceof Error ? e.message : String(e)}`;
    }
  };
}

// Loop agente: request → stream → si el modelo pidió tools, ejecutarlas y
// re-enviar con los resultados (role:"tool") hasta que responda contenido o
// se agoten los hops. Cada hop es un Job real: rutea, se telemetría y puede
// hacer failover como cualquier otro — las tools no esquivan la red.
export async function runAgent(
  base: string,
  model: string,
  messages: AgentMessage[],
  opts: {
    tools?: ToolDef[];
    think?: boolean;
    numCtx?: number;
    maxHops?: number;
    callTool?: (name: string, args: Record<string, unknown>) => Promise<string>;
  },
  cb: AgentCallbacks,
): Promise<void> {
  cb.onStatus("connecting");
  const decisionP = postJobs(base, model).catch(() => null);
  const t0 = performance.now();
  let first = -1;
  const msgs: AgentMessage[] = [...messages];
  const maxHops = Math.min(8, Math.max(1, opts.maxHops ?? 5));
  try {
    void decisionP.then((d) => {
      if (d) cb.onStatus("forge-selected", d.forge);
    });
    for (let hop = 0; hop < maxHops; hop++) {
      let finish = "stop";
      const calls: ToolCall[] = [];
      for await (const ev of streamChat(base, {
        model,
        messages: msgs,
        stream: true,
        ...(opts.tools?.length ? { tools: opts.tools } : {}),
        ...(opts.think !== undefined ? { think: opts.think } : {}),
        ...(opts.numCtx !== undefined ? { num_ctx: opts.numCtx } : {}),
      })) {
        if (ev.type === "delta") {
          const { reasoning, content, tool_calls } = ev.delta;
          if (reasoning) {
            if (first < 0) {
              first = performance.now();
              cb.onStatus("streaming");
            }
            cb.onReasoning?.(reasoning);
          }
          if (content) {
            if (first < 0) {
              first = performance.now();
              cb.onStatus("streaming");
            }
            cb.onToken(content);
          }
          for (const tc of tool_calls ?? []) {
            const name = tc.function?.name;
            if (!name) continue;
            let parsed: Record<string, unknown> = {};
            try {
              parsed = JSON.parse(tc.function?.arguments ?? "{}") as Record<string, unknown>;
            } catch {
              /* args malformados del modelo: van vacíos, el tool decide */
            }
            calls.push({ name, arguments: parsed });
          }
        } else if (ev.type === "finish") {
          finish = ev.reason;
          const u = ev.usage;
          if (u?.prompt_tokens !== undefined) cb.onUsage?.(u.prompt_tokens, u.completion_tokens ?? 0);
        } else if (ev.type === "error") {
          throw new Error(ev.error);
        }
      }
      if (finish !== "tool_calls" || calls.length === 0 || !opts.callTool) break;
      // Turno del assistant con tool_calls + resultados (shape nativo Ollama).
      msgs.push({
        role: "assistant",
        content: "",
        tool_calls: calls.map((c) => ({ function: { name: c.name, arguments: c.arguments } })),
      });
      for (const c of calls) {
        cb.onToolCall?.(c.name, c.arguments);
        const out = await opts.callTool(c.name, c.arguments);
        cb.onToolResult?.(c.name, out);
        msgs.push({ role: "tool", name: c.name, content: out });
      }
    }
    const decision = await decisionP;
    cb.onDone({
      forge: decision?.forge ?? "desconocido",
      ttftMs: Math.round(first < 0 ? performance.now() - t0 : first - t0),
      etrMs: decision?.etr_ms ?? 0,
      reason: decision?.reason ?? "sin-decisión",
    });
  } catch (e) {
    cb.onError(e instanceof Error ? e.message : "error de red");
  }
}
