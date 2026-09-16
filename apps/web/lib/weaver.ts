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

export async function setKill(base: string, dead: boolean): Promise<void> {
  const key = operatorKey();
  const r = await fetch(`${base}/v1/admin/kill`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({ dead }),
  });
  if (!r.ok) throw new Error(`kill: http ${r.status}`);
}

export type RunCallbacks = {
  onStatus: (s: RunStatus, detail?: string) => void;
  onToken: (t: string) => void;
  onDone: (meta: { forge: string; ttftMs: number; etrMs: number; reason: string }) => void;
  onError: (msg: string) => void;
};

// Pipeline honesto: 1) decisión real del scheduler, 2) stream real del chat.
export async function runChat(base: string, model: string, prompt: string, cb: RunCallbacks): Promise<void> {
  cb.onStatus("connecting");
  let decision: JobsDecision;
  try {
    decision = await postJobs(base, model);
  } catch {
    cb.onError("gateway caído — levantá :3001");
    return;
  }
  cb.onStatus("forge-selected", decision.forge);
  const t0 = performance.now();
  let first = -1;
  let text = "";
  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], stream: true }),
    });
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
          if (data === "[DONE]") {
            cb.onDone({ forge: decision.forge, ttftMs: Math.round(first < 0 ? performance.now() - t0 : first - t0), etrMs: decision.etr_ms, reason: decision.reason });
            return;
          }
          try {
            const json = JSON.parse(data) as { error?: string; choices?: { delta?: { content?: string } }[] };
            if (typeof json.error === "string" && json.error) throw new Error(json.error);
            const content = json.choices?.[0]?.delta?.content ?? "";
            if (content) {
              if (first < 0) {
                first = performance.now();
                cb.onStatus("streaming");
              }
              text += content;
              cb.onToken(content);
            }
          } catch (e) {
            if (e instanceof SyntaxError) continue;
            throw e;
          }
        }
      }
      if (done) break;
    }
    void text;
    cb.onError("stream cortado sin [DONE]");
  } catch (e) {
    cb.onError(e instanceof Error ? e.message : "error de red");
  }
}
