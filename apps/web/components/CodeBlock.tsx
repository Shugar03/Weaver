"use client";

import { useState } from "react";

export function CodeBlock({ title, lang, code }: { title: string; lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* portapapeles bloqueado */
    }
  }
  return (
    <div className="border border-line bg-panel">
      <div className="flex items-center justify-between border-b border-line px-4 py-2">
        <span className="font-tech text-lg tracking-[0.15em]">
          {title} <span className="text-fog">· {lang}</span>
        </span>
        <button onClick={copy} className="font-tech text-lg text-fog hover:text-lima">
          {copied ? "¡copiado!" : "copiar"}
        </button>
      </div>
      <pre className="overflow-x-auto p-4 font-tech text-[15px] leading-relaxed whitespace-pre">{code}</pre>
    </div>
  );
}
