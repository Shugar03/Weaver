"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AGENT_TOOLS,
  estimateContextTokens,
  fetchAgentManifest,
  getForges,
  loadMemory,
  makeToolExecutor,
  PLAN_TOOLS,
  runAgent,
  uploadDoc,
  type AgentManifest,
  type AgentMessage,
  type ForgeView,
  type RunStatus,
  type ToolDef,
} from "../../lib/weaver";
import { speak, startListening, stopSpeaking, sttSupported, ttsSupported, type SttHandle } from "../../lib/speech";
import { ThinkingBlock } from "../ThinkingBlock";

type Msg = {
  role: "user" | "weaver";
  text: string;
  thinking?: string;
  toolCalls?: string[];
  images?: string[]; // URLs /v1/media/<id> de artefactos generados por tools
  attachment?: string; // nombre del doc adjuntado (pdf/docx/txt → texto extraído)
  docText?: string; // texto extraído del adjunto — entra al contexto del modelo
  forge?: string;
  ttftMs?: number;
  etrMs?: number;
  reason?: string;
};

type Chat = { id: string; title: string; ts: number; messages: Msg[] };

const LS_KEY = "weaver:chat:recents";
const DEFAULT_MODEL = "qwen3:4b";

// Modos del agente: Ask = conversación pura (sin tools); Plan = solo lectura
// (tools de red read-only + server-tools readonly: web_search, web_fetch,
// skills); Exec = todo, incluido chaos (kill/revive), memoria y tools MCP
// (side-effects ajenos → jamás en Plan).
type Mode = "ask" | "plan" | "exec";
const NUM_CTX = 16384; // qwen3:4b aguanta mucho más; 16k cubre agente+historial sin inflar KV cache
function toolsForMode(mo: Mode, server: ToolDef[]): ToolDef[] {
  if (mo === "ask") return [];
  if (mo === "plan") return [...PLAN_TOOLS, ...server.filter((t) => t.readonly)];
  return [...AGENT_TOOLS, ...server];
}
const MODE_SYSTEM: Record<Mode, string> = {
  ask: "Sos Weaver Agent, un asistente que corre sobre Weaver: una red de inferencia distribuida con forges reales y settlement en Stellar. Respondé directo y conciso, en el idioma del usuario.",
  plan: "Sos Weaver Agent sobre la red Weaver. MODO PLAN: planificá en pasos numerados y usá las tools de lectura (list_forges, route_check, network_usage, recent_executions) para traer datos reales de la red cuando sean relevantes. No podés mutar el sistema.",
  exec: "Sos Weaver Agent sobre la red Weaver. MODO EXEC: tenés tools reales para inspeccionar y operar la red (list_forges, route_check, network_usage, recent_executions, kill_forge, revive_forge) y memoria local (remember, forget). Usá tools solo cuando agreguen datos reales o el usuario pida una acción; si no, respondé directo. Conciso, idioma del usuario.",
};

function loadRecents(): Chat[] {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) ?? "[]") as Chat[];
  } catch {
    return [];
  }
}

// Render mínimo de markdown del modelo: **bold**, "- " bullets, "## " títulos. Nada más.
function RichText({ text }: { text: string }) {
  const lines = text.split("\n");
  const out: React.ReactNode[] = [];
  let bullets: string[] = [];
  const flush = (key: string) => {
    if (bullets.length > 0) {
      out.push(
        <ul key={key} className="mt-2 space-y-1.5">
          {bullets.map((b, i) => (
            <li key={i} className="flex gap-2.5">
              <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-lima" />
              <span>{inline(b)}</span>
            </li>
          ))}
        </ul>,
      );
      bullets = [];
    }
  };
  lines.forEach((ln, i) => {
    const t = ln.trim();
    if (t.startsWith("- ")) {
      bullets.push(t.slice(2));
      return;
    }
    flush(`u${i}`);
    if (t.startsWith("## ")) {
      out.push(<div key={i} className="mt-4 font-bold text-white">{inline(t.slice(3))}</div>);
    } else if (t === "") {
      out.push(<div key={i} className="h-2" />);
    } else {
      out.push(<p key={i}>{inline(t)}</p>);
    }
  });
  flush("end");
  return <>{out}</>;
}

function inline(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) =>
    p.startsWith("**") && p.endsWith("**") ? (
      <strong key={i} className="font-bold text-white">{p.slice(2, -2)}</strong>
    ) : (
      <span key={i}>{p}</span>
    ),
  );
}

const STAGES: { key: RunStatus; label: (d: string) => string }[] = [
  { key: "connecting", label: () => "Conectando red" },
  { key: "forge-selected", label: (d) => `Forge ${d || "…"}` },
  { key: "streaming", label: () => "Generando respuesta" },
  { key: "completed", label: () => "Listo" },
];

// Glifo fosforo: el busy-indicator de terminal, un solo caracter ciclando.
// Vive en el bullet de la etapa activa — nada más se mueve en pantalla.
const PHOSPHOR = "░▒▓█▓▒░";
function PhosphorGlyph() {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = setInterval(() => setI((v) => (v + 1) % PHOSPHOR.length), 90);
    return () => clearInterval(id);
  }, []);
  return <span className="text-lima [text-shadow:0_0_10px_rgba(208,255,0,0.5)]">{PHOSPHOR[i]} </span>;
}

export function ChatApp({ base }: { base: string }) {
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeId, setActiveId] = useState(() => `c-${Date.now()}`);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<RunStatus>("idle");
  const [statusDetail, setStatusDetail] = useState("");
  const [mode, setMode] = useState<Mode>("exec");
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [forges, setForges] = useState<ForgeView[] | null>(null);
  const [ttfts, setTtfts] = useState<number[]>([]);
  const [lastForge, setLastForge] = useState<string | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const [manifest, setManifest] = useState<AgentManifest | null>(null);
  // Medidor de contexto: prompt_tokens real del último hop, o estimado del
  // payload que está por salir. El real siempre gana cuando existe.
  const [ctxTokens, setCtxTokens] = useState<number | null>(null);
  // Sesión: suma real de tokens (prompt+completion) de todos los hops.
  const [sessionTokens, setSessionTokens] = useState(0);
  // Doc adjuntado al próximo mensaje (texto ya extraído por el gateway).
  const [attachedDoc, setAttachedDoc] = useState<{ name: string; chars: number; text: string } | null>(null);
  const [attaching, setAttaching] = useState(false);
  // Audio on-device: STT llena el input (auto-envía al resultado final),
  // TTS lee respuestas (▶ por mensaje, o automático si VOZ ON).
  const [listening, setListening] = useState(false);
  const [voiceOn, setVoiceOn] = useState(false);
  // false en SSR y en el primer render cliente → hydration limpia; post-mount
  // refleja el support real del browser.
  const [speech, setSpeech] = useState({ stt: false, tts: false });
  useEffect(() => setSpeech({ stt: sttSupported, tts: ttsSupported }), []);
  const sttRef = useRef<SttHandle | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => () => {
    sttRef.current?.stop();
    stopSpeaking();
  }, []);

  useEffect(() => {
    setChats(loadRecents());
    // ?model= desde el marketplace (/models/[id] → TRY IN CHAT). El efecto de
    // forges corrige si el id no es servido por ningún forge de texto.
    const q = new URLSearchParams(window.location.search).get("model");
    if (q) setModel(q);
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      const f = await getForges(base).catch(() => null);
      if (alive) setForges(f);
    };
    poll();
    const id = setInterval(poll, 10000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [base]);

  // Si el modelo elegido no es servido por ningún forge de TEXTO (p.ej. quedó
  // seleccionado el modelo de imagen), cae al primer modelo de chat disponible.
  useEffect(() => {
    if (!forges?.length) return;
    const textModels = [...new Set(forges.filter((f) => (f.capability ?? "text") === "text").map((f) => f.model))];
    if (textModels.length && !textModels.includes(model)) setModel(textModels[0]);
  }, [forges]);

  // Manifest del agent host: persona (AGENT.md), skills y server-tools.
  // Se re-pide con el poll de forges — si el operador enchufa un MCP server
  // nuevo, aparece solo sin recargar.
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      const m = await fetchAgentManifest(base);
      if (alive && m) setManifest(m);
    };
    poll();
    const id = setInterval(poll, 30000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [base]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  const persist = useCallback((id: string, title: string, msgs: Msg[]) => {
    setChats((prev) => {
      const next = [{ id, title, ts: Date.now(), messages: msgs }, ...prev.filter((c) => c.id !== id)].slice(0, 20);
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(next));
      } catch {
        /* almacenamiento lleno: la sesión sigue viva en memoria */
      }
      return next;
    });
  }, []);

  async function send(retryText?: string) {
    const doc = retryText ? null : attachedDoc;
    const prompt = (retryText ?? input).trim() || (doc ? "Analizá el archivo adjunto." : "");
    if ((!prompt && !doc) || busy) return;
    setBusy(true);
    setAttachedDoc(null);
    setInput("");
    const userMsg: Msg = { role: "user", text: prompt, attachment: doc?.name, docText: doc?.text };
    const base_msgs = retryText ? messages.filter((m) => !(m.role === "user" && m.text === prompt)) : messages;
    const withUser = [...base_msgs, userMsg];
    setMessages(withUser);
    const chatId = activeId;
    const title = withUser.find((m) => m.role === "user")?.text.slice(0, 42) ?? "New chat";
    // Historial real al modelo: persona (AGENT.md del nodo) + instrucciones del
    // modo + índice de skills + memoria local + últimos mensajes (sin thinking —
    // el razonamiento no se re-envía, ahorra contexto).
    const mem = loadMemory();
    const serverTools = manifest?.tools ?? [];
    const tools = toolsForMode(mode, serverTools);
    const system = [
      manifest?.persona,
      MODE_SYSTEM[mode],
      manifest?.skills.length
        ? `Skills instaladas (cargá una con load_skill cuando la tarea la pida):\n${manifest.skills.map((s) => `- ${s.name}: ${s.description}`).join("\n")}`
        : null,
      mem.length ? `Memoria del usuario (local, persistente):\n${mem.map((m, i) => `${i}. ${m}`).join("\n")}` : null,
    ]
      .filter(Boolean)
      .join("\n\n");
    const history: AgentMessage[] = [
      { role: "system", content: system },
      ...withUser
        .filter((m) => !m.text.startsWith("■"))
        .slice(-10)
        .map((m) => ({
          role: m.role === "user" ? "user" : "assistant",
          content: m.docText ? `[archivo adjunto: ${m.attachment}]\n${m.docText}\n\n${m.text}` : m.text,
        })),
    ];
    setCtxTokens(estimateContextTokens(history, tools));
    const callTool = makeToolExecutor(base, new Set(serverTools.map((t) => t.function.name)));
    let acc = "";
    let accThink = "";
    const toolList: string[] = [];
    const mediaList: string[] = [];
    const liveMsg = (): Msg => ({
      role: "weaver",
      text: acc,
      thinking: accThink || undefined,
      toolCalls: toolList.length ? [...toolList] : undefined,
      images: mediaList.length ? [...mediaList] : undefined,
    });
    await runAgent(
      base,
      model,
      history,
      { tools, numCtx: NUM_CTX, callTool },
      {
        onStatus: (s, detail) => {
          setStatus(s);
          setStatusDetail(detail ?? "");
        },
        onUsage: (promptTokens, completionTokens) => {
          setCtxTokens(promptTokens);
          setSessionTokens((t) => t + promptTokens + completionTokens);
        },
        onReasoning: (t) => {
          accThink += t;
          setMessages([...withUser, liveMsg()]);
        },
        onToken: (t) => {
          acc += t;
          setMessages([...withUser, liveMsg()]);
        },
        onToolCall: (name) => {
          toolList.push(name);
          setMessages([...withUser, liveMsg()]);
        },
        onToolResult: (_name, result) => {
          // Artefactos: el tool devuelve "media:/v1/media/<id>" — se renderiza inline.
          for (const m of result.matchAll(/media:(\/v1\/media\/[a-zA-Z0-9-]+)/g)) {
            mediaList.push(`${base}${m[1]}`);
          }
          if (mediaList.length) setMessages([...withUser, liveMsg()]);
        },
        onDone: (m) => {
          const final: Msg[] = [
            ...withUser,
            { ...liveMsg(), forge: m.forge, ttftMs: m.ttftMs, etrMs: m.etrMs, reason: m.reason },
          ];
          setMessages(final);
          setTtfts((prev) => [...prev.slice(-19), m.ttftMs]);
          if (m.forge) setLastForge(m.forge);
          setStatus("idle");
          setStatusDetail("");
          setBusy(false);
          persist(chatId, title, final);
          if (voiceOn && acc) speak(acc);
        },
        onError: (msg) => {
          const final: Msg[] = [...withUser, { role: "weaver", text: `■ ${msg}` }];
          setMessages(final);
          setStatus("idle");
          setStatusDetail("");
          setBusy(false);
          persist(chatId, title, final);
        },
      },
    );
  }

  function toggleMic() {
    if (listening) {
      sttRef.current?.stop();
      return;
    }
    const base = input; // texto ya escrito: la voz se le agrega
    const h = startListening({
      onText: (text, isFinal) => {
        const joined = (base ? base + " " : "") + text;
        setInput(joined);
        if (isFinal) void send(joined); // frase completa → se envía sola
      },
      onEnd: () => setListening(false),
      onError: () => setListening(false),
    });
    if (!h) return;
    sttRef.current = h;
    setListening(true);
  }

  function newChat() {
    const id = `c-${Date.now()}`;
    setActiveId(id);
    setMessages([]);
    setStatus("idle");
    setStatusDetail("");
  }

  function openChat(c: Chat) {
    setActiveId(c.id);
    setMessages(c.messages);
    setStatus("idle");
    setStatusDetail("");
  }

  // ZDR también es poder borrar lo tuyo: vive solo en tu browser, se borra acá.
  function deleteChat(id: string) {
    setChats((prev) => {
      const next = prev.filter((c) => c.id !== id);
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(next));
      } catch {
        /* nada */
      }
      return next;
    });
    if (id === activeId) {
      setActiveId(`c-${Date.now()}`);
      setMessages([]);
      setStatus("idle");
      setStatusDetail("");
    }
  }

  async function copy(text: string, i: number) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(i);
      setTimeout(() => setCopied(null), 1200);
    } catch {
      /* portapapeles bloqueado: nada que hacer */
    }
  }

  const running = status !== "idle";
  const hot = forges?.filter((f) => f.hot).length ?? 0;
  const p50 = ttfts.length > 0 ? [...ttfts].sort((a, b) => a - b)[Math.floor((ttfts.length - 1) / 2)] : null;
  const stageIdx = status === "idle" ? -1 : STAGES.findIndex((s) => s.key === (status === "error" ? "connecting" : status));

  return (
    <div className="flex h-dvh bg-void text-white">
      {/* SIDEBAR */}
      {!collapsed && (
        <aside className="hidden w-64 shrink-0 flex-col border-r border-line bg-panel lg:flex">
          <div className="flex items-center justify-between p-4">
            <a href="/" className="flex items-center gap-2.5">
              <Image src="/weaver-mark.png" alt="Weaver" width={26} height={26} />
              <span className="text-base font-bold tracking-[0.3em]">WEAVER</span>
            </a>
            <button onClick={() => setCollapsed(true)} title="Colapsar" className="border border-line px-2 py-1 font-tech text-fog hover:text-white">
              {"◧"}
            </button>
          </div>
          <div className="px-3">
            <button
              onClick={newChat}
              className="flex w-full items-center gap-2 border border-line px-3 py-2.5 font-tech text-lg text-lima hover:border-lima"
            >
              <span className="text-xl leading-none">+</span> New chat
              <span className="ml-auto border border-line px-1.5 text-sm text-fog">⌘K</span>
            </button>
            {[
              { label: "Explore", soon: true },
              { label: "Library", soon: true },
              { label: "Agents", soon: true },
            ].map((r) => (
              <div key={r.label} className="mt-1 flex items-center justify-between px-3 py-2 font-tech text-lg text-fog">
                <span>{r.label}</span>
                <span className="border border-line px-1.5 text-sm">SOON</span>
              </div>
            ))}
            <a href="/network" className="mt-1 block px-3 py-2 font-tech text-lg text-white hover:text-lima">
              Compute →
            </a>
          </div>
          <div className="mt-4 border-t border-line px-3 pt-3">
            <div className="px-1 font-tech text-sm tracking-[0.2em] text-fog">Recent</div>
            <div className="mt-1 space-y-0.5">
              {chats.slice(0, 5).map((c) => (
                <div key={c.id} className="group flex items-center">
                  <button
                    onClick={() => openChat(c)}
                    className={`block min-w-0 flex-1 truncate px-2 py-1.5 text-left font-tech text-lg hover:bg-line/60 ${
                      c.id === activeId ? "text-lima" : "text-fog"
                    }`}
                  >
                    {c.title}
                  </button>
                  <button
                    onClick={() => deleteChat(c.id)}
                    title="Borrar (solo existe en tu browser)"
                    className="shrink-0 px-2 font-tech text-lg text-fog hover:text-danger md:hidden md:group-hover:block"
                  >
                    ×
                  </button>
                </div>
              ))}
              {chats.length === 0 && <div className="px-2 py-1.5 font-tech text-lg text-fog">Sin chats todavía.</div>}
            </div>
          </div>
          <div className="mt-auto space-y-3 p-3">
            <div className="border border-line px-3 py-2 font-tech text-lg">
              <span className="text-lima">●</span> Global compute
              <div className="text-fog">{forges === null ? "offline" : `${forges.length} forges online`}</div>
            </div>
            <div className="flex items-center gap-2.5 px-1">
              <span className="flex h-8 w-8 items-center justify-center border border-lima font-tech text-lg text-lima">S</span>
              <div>
                <div className="text-sm font-bold">Sebastian</div>
                <div className="font-tech text-sm text-fog">LOCAL</div>
              </div>
            </div>
          </div>
        </aside>
      )}

      {/* CENTRO */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-line px-4">
          <div className="flex items-center gap-2">
            {collapsed && (
              <button onClick={() => setCollapsed(false)} title="Expandir" className="border border-line px-2 py-1 font-tech text-fog hover:text-white lg:hidden xl:block">
                {"◧"}
              </button>
            )}
            <span className="text-lima">▲</span>
            <span className="font-bold">Weaver Agent</span>
            <span className="font-tech text-base text-fog">{model} · global compute</span>
          </div>
          <div className="flex items-center gap-3">
            {speech.tts && (
              <button
                onClick={() => {
                  const next = !voiceOn;
                  setVoiceOn(next);
                  if (!next) stopSpeaking();
                }}
                title={voiceOn ? "Voz automática: ON — cada respuesta se lee en voz alta" : "Voz automática: OFF"}
                className={`font-tech text-base tracking-[0.15em] ${voiceOn ? "text-lima" : "text-fog hover:text-white"}`}
              >
                ◉ {voiceOn ? "VOZ ON" : "VOZ"}
              </button>
            )}
            <span className="hidden font-tech text-sm tracking-[0.2em] text-fog md:block">OPEN COMPUTE. HIGHER INTELLIGENCE.</span>
          </div>
        </div>

        <div className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto px-4 py-6">
          {messages.length === 0 && (
            <div className="mt-16 text-center">
              <div className="font-tech text-lg tracking-[0.2em] text-fog">{"//"} WEAVER</div>
              <div className="mt-2 text-3xl font-bold">
                Real AI. <span className="text-lima">Distributed.</span>
              </div>
              <div className="mt-2 font-tech text-lg text-fog">Escribí abajo. Corre en tu red, no en una nube ajena.</div>
            </div>
          )}
          {messages.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="mt-5 text-right">
                <div className="font-tech text-sm tracking-[0.2em] text-fog">{"//"} YOU</div>
                {m.attachment && (
                  <div className="ml-auto mt-1 flex w-fit items-center gap-2 border border-line px-2 py-1 font-tech text-base text-fog">
                    <span className="text-lima">▤</span> {m.attachment}
                  </div>
                )}
                <div className="ml-auto mt-1 max-w-[85%] border border-line bg-panel px-4 py-3 text-left text-[15px] leading-relaxed">
                  {m.text}
                </div>
              </div>
            ) : (
              <div key={i} className="mt-5">
                <div className="flex items-center gap-2 font-tech text-sm tracking-[0.2em] text-fog">
                  <Image src="/weaver-mark.png" alt="" width={18} height={18} />
                  {"//"} WEAVER
                  {speech.tts && m.text && (
                    <button
                      onClick={() => speak(m.text)}
                      title="Leer en voz alta"
                      className="text-fog transition-colors hover:text-lima"
                    >
                      ▶
                    </button>
                  )}
                </div>
                {m.thinking && (
                  <div className="mt-1 max-w-[95%]">
                    <ThinkingBlock text={m.thinking} />
                  </div>
                )}
                {m.toolCalls && m.toolCalls.length > 0 && (
                  <div className="mt-1 font-tech text-base text-fog">
                    {m.toolCalls.map((t, j) => (
                      <span key={j} className="mr-3">
                        → <span className="text-lima">{t}</span>
                      </span>
                    ))}
                  </div>
                )}
                {m.images && m.images.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {m.images.map((src, j) => (
                      // Artefacto generado por un forge de imagen, servido por el gateway.
                      // eslint-disable-next-line @next/next/no-img-element -- URL dinámica de media store
                      <img key={j} src={src} alt="imagen generada por la red" className="max-w-md border border-line" />
                    ))}
                  </div>
                )}
                <div className="mt-1 max-w-[95%] text-[15px] leading-relaxed text-white/90">
                  <RichText text={m.text} />
                </div>
                {(m.forge || m.ttftMs !== undefined) && (
                  <div className="mt-2 font-tech text-base text-fog">
                    {m.forge && (
                      <>
                        FORGE <span className="text-lima">{m.forge}</span>
                      </>
                    )}
                    {m.ttftMs !== undefined && (
                      <>
                        {"  "}TTFT <span className="text-white">{m.ttftMs} ms</span>
                      </>
                    )}
                    {m.etrMs !== undefined && (
                      <>
                        {"  "}ETR <span className="text-white">{m.etrMs} ms</span>
                      </>
                    )}
                  </div>
                )}
                <div className="mt-1.5 flex gap-3 font-tech text-base text-fog">
                  <button onClick={() => copy(m.text, i)} className="hover:text-lima">
                    {copied === i ? "¡copiado!" : "copiar"}
                  </button>
                  <button
                    onClick={() => {
                      const lastUser = [...messages.slice(0, i)].reverse().find((x) => x.role === "user");
                      if (lastUser) send(lastUser.text);
                    }}
                    className="hover:text-lima"
                  >
                    reintentar
                  </button>
                </div>
              </div>
            ),
          )}
          {running && stageIdx >= 0 && (
            <div className="mt-5 border-l border-line pl-4 font-tech text-lg">
              <div className="text-sm tracking-[0.2em] text-fog">{"//"} THINKING</div>
              <div className="text-white">
                <PhosphorGlyph />
                {STAGES[stageIdx].label(statusDetail)}
              </div>
            </div>
          )}
          <div ref={bottomRef} className="h-4" />
        </div>

        <div className="mx-auto w-full max-w-3xl px-4 pb-3">
          <div className="border border-line bg-panel px-4 pt-3 pb-2">
            {attachedDoc && (
              <div className="mb-2 flex items-center gap-2 border border-line px-2 py-1 font-tech text-base">
                <span className={attachedDoc.chars > 0 ? "text-lima" : "text-danger"}>▤</span>
                <span className="truncate">{attachedDoc.name}</span>
                {attachedDoc.chars > 0 && <span className="text-fog">{(attachedDoc.chars / 1000).toFixed(1)}k chars</span>}
                <button onClick={() => setAttachedDoc(null)} title="Quitar" className="ml-auto text-fog hover:text-white">×</button>
              </div>
            )}
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={2}
              placeholder="Escribe un mensaje..."
              className="w-full resize-none bg-transparent text-[15px] outline-none placeholder:text-fog"
            />
            <div className="mt-1 flex items-center gap-2 pb-1">
              <input
                ref={fileRef}
                type="file"
                accept=".txt,.md,.markdown,.csv,.json,.log,.yaml,.yml,.xml,.toml,.pdf,.docx,.ts,.tsx,.js,.jsx,.py,.rs,.go,.java,.c,.cpp,.h,.css,.html,.sql,.sh"
                className="hidden"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (!f) return;
                  setAttaching(true);
                  try {
                    setAttachedDoc(await uploadDoc(base, f));
                  } catch (err) {
                    setAttachedDoc({ name: `⚠ ${f.name}`, chars: 0, text: "" });
                    console.error("uploadDoc:", err);
                  } finally {
                    setAttaching(false);
                  }
                }}
              />
              <button
                title="Adjuntar documento (pdf/docx/txt/código → texto para el agente)"
                onClick={() => fileRef.current?.click()}
                disabled={busy || attaching}
                className="border border-line px-2.5 py-1 font-tech text-lg text-fog hover:border-lima hover:text-lima disabled:opacity-50"
              >
                {attaching ? "…" : "+"}
              </button>
              {speech.stt && (
                <button
                  title={listening ? "Escuchando… (tocá para cortar)" : "Hablar — la frase se envía sola"}
                  onClick={toggleMic}
                  disabled={busy}
                  className={`border px-2.5 py-1 font-tech text-base ${
                    listening ? "border-lima bg-lima/10 text-lima" : "border-line text-fog hover:border-lima hover:text-lima"
                  } disabled:opacity-50`}
                >
                  {listening ? "◉ rec" : "◉"}
                </button>
              )}
              {/* Web/DeepResearch: sin botones — web_search ya es tool del agente
                  y deep-research es una orquestación, no un toggle. */}
              <span className="ml-auto flex items-center gap-2">
                <span className="flex border border-line" title="Ask: sin tools · Plan: solo lectura de la red · Exec: tools completas">
                  {(["ask", "plan", "exec"] as const).map((mo) => (
                    <button
                      key={mo}
                      onClick={() => setMode(mo)}
                      className={`px-2.5 py-1 font-tech text-base uppercase ${
                        mode === mo ? "bg-lima text-black" : "text-fog hover:text-white"
                      }`}
                    >
                      {mo}
                    </button>
                  ))}
                </span>
                <select
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  title="Modelo servido por la fleet"
                  className="cursor-pointer border border-line bg-panel px-2.5 py-1 font-tech text-base text-fog"
                >
                  {[...new Set([
                    // Solo modelos de texto: la fleet también lista el forge de
                    // imagen — elegirlo acá mandaría chat a difusión (sin execs).
                    ...(forges ?? []).filter((f) => (f.capability ?? "text") === "text").map((f) => f.model),
                    model,
                  ])].map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </span>
              <button
                onClick={() => send()}
                disabled={busy || (!input.trim() && !attachedDoc)}
                title="Enviar"
                className="bg-lima px-3.5 py-1 text-xl font-bold text-black transition-transform active:translate-y-[1px] disabled:opacity-40"
              >
                ↑
              </button>
            </div>
          </div>
          <div className="py-1 text-center font-tech text-sm text-fog">
            Built on a global network of GPUs. Responses may vary by forge.
          </div>
        </div>
      </div>

      {/* RAIL DERECHO */}
      <aside className="hidden w-72 shrink-0 flex-col gap-5 overflow-y-auto border-l border-line bg-panel p-4 xl:flex">
        <div>
          <div className="font-tech text-base tracking-[0.2em] text-fog">{"//"} CONTEXT</div>
          <div className="mt-2 border border-line px-3 py-2.5 font-tech">
            <div className="flex justify-between text-lg">
              <span className="text-fog">tokens</span>
              <span>
                {ctxTokens === null ? "—" : ctxTokens >= 1000 ? `~${(ctxTokens / 1000).toFixed(1)}k` : ctxTokens}
                <span className="text-fog"> / {NUM_CTX / 1024}k</span>
              </span>
            </div>
            <div className="mt-1.5 h-1.5 w-full bg-line">
              <div
                className={`h-full transition-all ${ctxTokens !== null && ctxTokens / NUM_CTX > 0.85 ? "bg-danger" : "bg-lima"}`}
                style={{ width: `${Math.min(100, ((ctxTokens ?? 0) / NUM_CTX) * 100)}%` }}
              />
            </div>
            <div className="mt-2 border-t border-line pt-2 text-sm text-fog">
              {manifest === null
                ? "agent host offline"
                : `${manifest.tools.length} server tools · ${manifest.skills.length} skills${manifest.persona ? " · AGENT.md" : ""}`}
            </div>
            <div className="mt-1 flex justify-between border-t border-line pt-2 text-sm text-fog">
              <span>sesión</span>
              <span>{sessionTokens === 0 ? "—" : sessionTokens >= 1000 ? `${(sessionTokens / 1000).toFixed(1)}k tok` : `${sessionTokens} tok`}</span>
            </div>
          </div>
        </div>
        <div>
          <div className="font-tech text-base tracking-[0.2em] text-fog">{"//"} MCP</div>
          <div className="mt-2 border border-line px-3 py-2.5 font-tech text-base">
            {!manifest?.mcp?.length ? (
              <div className="text-fog">sin servers configurados</div>
            ) : (
              manifest.mcp.map((s) => (
                <div key={s.name} className="flex items-center justify-between py-0.5">
                  <span>
                    <span className={s.status === "ok" ? "text-lima" : s.status === "failed" ? "text-danger" : "text-fog"}>●</span>{" "}
                    {s.name}
                  </span>
                  <span className="text-fog">
                    {s.status === "ok" ? `${s.tools} tools` : s.status === "failed" ? "falló" : "down"}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
        <div>
          <div className="font-tech text-base tracking-[0.2em] text-fog">{"//"} COMPUTE</div>
          <div className="mt-2 border border-line px-3 py-2.5">
            <div className="font-tech text-xl">
              <span className="text-lima">●</span> Global network
            </div>
            <div className="font-tech text-base text-fog">
              {forges === null ? "gateway offline" : `${forges.length} forges online`}
            </div>
            <div className="mt-2 space-y-1 border-t border-line pt-2 font-tech text-lg">
              <div className="flex justify-between">
                <span className="text-fog">Esta sesión</span>
                <span>{ttfts.length} runs</span>
              </div>
              <div className="flex justify-between">
                <span className="text-fog">p50 TTFT</span>
                <span>{p50 === null ? "—" : `${p50} ms`}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-fog">Último servido</span>
                <span className="text-lima">{lastForge ?? "—"}</span>
              </div>
            </div>
            <a href="/network" className="mt-2 block font-tech text-lg text-lima hover:underline">
              Abrir consola →
            </a>
          </div>
        </div>
      </aside>
    </div>
  );
}
