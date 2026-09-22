// Audio del agente — 100% browser/on-device, nada pasa por la red.
// STT: Web Speech API (on-device en Apple Silicon). TTS: speechSynthesis.

export type SttHandle = { stop: () => void };

const Recognition =
  typeof window !== "undefined"
    ? ((window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown }).SpeechRecognition ??
      (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition)
    : undefined;

export const sttSupported = !!Recognition;
export const ttsSupported = typeof window !== "undefined" && "speechSynthesis" in window;

// Escucha una sola frase: interim results llenan el input en vivo, el resultado
// final dispara onFinal (el caller decide si auto-envía).
export function startListening(opts: {
  onText: (text: string, isFinal: boolean) => void;
  onEnd: () => void;
  onError: (e: string) => void;
}): SttHandle | null {
  if (!Recognition) return null;
  const Rec = Recognition as new () => {
    lang: string;
    continuous: boolean;
    interimResults: boolean;
    onresult: (e: { results: { isFinal: boolean; 0: { transcript: string } }[] }) => void;
    onend: () => void;
    onerror: (e: { error?: string }) => void;
    start: () => void;
    stop: () => void;
  };
  const rec = new Rec();
  rec.lang = navigator.language || "es-ES";
  rec.continuous = false;
  rec.interimResults = true;
  rec.onresult = (e) => {
    let final = "";
    let interim = "";
    for (const r of e.results) {
      if (r.isFinal) final += r[0].transcript;
      else interim += r[0].transcript;
    }
    opts.onText(final || interim, !!final);
  };
  rec.onend = () => opts.onEnd();
  rec.onerror = (e) => opts.onError(e.error ?? "mic");
  rec.start();
  return { stop: () => rec.stop() };
}

// Una respuesta a la vez: hablar cancela lo que esté sonando.
export function speak(text: string) {
  if (!ttsSupported) return;
  window.speechSynthesis.cancel();
  const clean = text.replace(/[#*`_>\[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 4000);
  if (!clean) return;
  const u = new SpeechSynthesisUtterance(clean);
  u.lang = navigator.language || "es-ES";
  const es = window.speechSynthesis.getVoices().find((v) => v.lang.startsWith("es"));
  if (es) u.voice = es;
  window.speechSynthesis.speak(u);
}

export function stopSpeaking() {
  if (ttsSupported) window.speechSynthesis.cancel();
}
