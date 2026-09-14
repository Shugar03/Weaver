"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import { getForges, runChat, type ForgeView, type RunStatus } from "../../lib/weaver";

type Msg = {
  role: "user" | "weaver";
  text: string;
  forge?: string;
  ttftMs?: number;
  etrMs?: number;
  reason?: string;
};

type Chat = { id: string; title: string; ts: number; messages: Msg[] };

const LS_KEY = "weaver:chat:recents";
const MODEL = "qwen3:4b";

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

export function ChatApp({ base }: { base: string }) {
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeId, setActiveId] = useState(() => `c-${Date.now()}`);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<RunStatus>("idle");
  const [statusDetail, setStatusDetail] = useState("");
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [forges, setForges] = useState<ForgeView[] | null>(null);
  const [ttfts, setTtfts] = useState<number[]>([]);
  const [copied, setCopied] = useState<number | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setChats(loadRecents());
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
    const prompt = (retryText ?? input).trim();
    if (!prompt || busy) return;
    setBusy(true);
    const userMsg: Msg = { role: "user", text: prompt };
    const base_msgs = retryText ? messages.filter((m) => !(m.role === "user" && m.text === prompt)) : messages;
    const withUser = [...base_msgs, userMsg];
    setMessages(withUser);
    setInput("");
    const chatId = activeId;
    const title = withUser.find((m) => m.role === "user")?.text.slice(0, 42) ?? "New chat";
    let acc = "";
    await runChat(base, MODEL, prompt, {
      onStatus: (s, detail) => {
        setStatus(s);
        setStatusDetail(detail ?? "");
      },
      onToken: (t) => {
        acc += t;
        setMessages([...withUser, { role: "weaver", text: acc }]);
      },
      onDone: (m) => {
        const final: Msg[] = [...withUser, { role: "weaver", text: acc, forge: m.forge, ttftMs: m.ttftMs, etrMs: m.etrMs, reason: m.reason }];
        setMessages(final);
        setTtfts((prev) => [...prev.slice(-19), m.ttftMs]);
        setStatus("idle");
        setStatusDetail("");
        setBusy(false);
        persist(chatId, title, final);
      },
      onError: (msg) => {
        const final: Msg[] = [...withUser, { role: "weaver", text: `■ ${msg}` }];
        setMessages(final);
        setStatus("idle");
        setStatusDetail("");
        setBusy(false);
        persist(chatId, title, final);
      },
    });
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
              <Image src="/weaver-logo.png" alt="Weaver" width={26} height={26} />
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
            <a href="/dashboard" className="mt-1 block px-3 py-2 font-tech text-lg text-white hover:text-lima">
              Compute →
            </a>
          </div>
          <div className="mt-4 border-t border-line px-3 pt-3">
            <div className="px-1 font-tech text-sm tracking-[0.2em] text-fog">Recent</div>
            <div className="mt-1 space-y-0.5">
              {chats.slice(0, 5).map((c) => (
                <button
                  key={c.id}
                  onClick={() => openChat(c)}
                  className={`block w-full truncate px-2 py-1.5 text-left font-tech text-lg hover:bg-line/60 ${
                    c.id === activeId ? "text-lima" : "text-fog"
                  }`}
                >
                  {c.title}
                </button>
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
            <span className="font-tech text-base text-fog">qwen3:4b · global compute</span>
          </div>
          <div className="hidden font-tech text-sm tracking-[0.2em] text-fog md:block">OPEN COMPUTE. HIGHER INTELLIGENCE.</div>
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
                <div className="ml-auto mt-1 max-w-[85%] border border-line bg-panel px-4 py-3 text-left text-[15px] leading-relaxed">
                  {m.text}
                </div>
              </div>
            ) : (
              <div key={i} className="mt-5">
                <div className="flex items-center gap-2 font-tech text-sm tracking-[0.2em] text-fog">
                  <Image src="/weaver-logo.png" alt="" width={18} height={18} />
                  {"//"} WEAVER
                </div>
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
          {running && (
            <div className="mt-5 border-l border-line pl-4 font-tech text-lg">
              <div className="text-sm tracking-[0.2em] text-fog">{"//"} THINKING</div>
              {STAGES.map((s, idx) => (
                <div key={s.key} className={idx <= stageIdx ? "text-white" : "text-fog/50"}>
                  <span className={idx < stageIdx ? "text-lima" : idx === stageIdx ? "animate-pulse text-lima" : ""}>
                    {idx < stageIdx ? "● " : idx === stageIdx ? "● " : "○ "}
                  </span>
                  {s.label(statusDetail)}
                </div>
              ))}
            </div>
          )}
          <div ref={bottomRef} className="h-4" />
        </div>

        <div className="mx-auto w-full max-w-3xl px-4 pb-3">
          <div className="border border-line bg-panel px-4 pt-3 pb-2">
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
              <button title="Adjuntos: pronto" disabled className="border border-line px-2.5 py-1 font-tech text-lg text-fog opacity-50">
                +
              </button>
              <button title="Web: pronto" disabled className="border border-line px-2.5 py-1 font-tech text-base text-fog opacity-50">
                Web
              </button>
              <button title="Deep Research: pronto" disabled className="hidden border border-line px-2.5 py-1 font-tech text-base text-fog opacity-50 sm:block">
                Deep Research
              </button>
              <span className="ml-auto border border-line px-2.5 py-1 font-tech text-base text-fog">qwen3:4b ▾</span>
              <button
                onClick={() => send()}
                disabled={busy || !input.trim()}
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
          <div className="font-tech text-base tracking-[0.2em] text-fog">{"//"} TOOLKIT</div>
          {[
            { label: "Code", sub: "Write, run, iterate", live: true },
            { label: "Image", sub: "Generate and edit", live: false },
            { label: "Analyze", sub: "Data, files, insights", live: false },
            { label: "Search", sub: "Real-time information", live: false },
          ].map((t) => (
            <div key={t.label} className="mt-2 flex items-center gap-3 border border-line px-3 py-2.5">
              <span className={`flex h-8 w-8 items-center justify-center border ${t.live ? "border-lima text-lima" : "border-line text-fog"}`}>
                {t.label[0]}
              </span>
              <div>
                <div className="text-sm font-bold">{t.label}</div>
                <div className="font-tech text-sm text-fog">{t.live ? t.sub : "Coming soon"}</div>
              </div>
            </div>
          ))}
        </div>
        <div>
          <div className="font-tech text-base tracking-[0.2em] text-fog">{"//"} CONTEXT</div>
          <div className="mt-2 border border-line px-3 py-2.5 font-tech text-lg text-fog">
            0 files
            <div className="text-sm">Adjuntos: pronto.</div>
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
            </div>
            <a href="/dashboard" className="mt-2 block font-tech text-lg text-lima hover:underline">
              Abrir consola →
            </a>
          </div>
        </div>
      </aside>
    </div>
  );
}
