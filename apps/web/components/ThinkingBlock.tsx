"use client";

import { useState } from "react";

// El razonamiento del modelo, colapsado por defecto: el usuario decide cuándo
// mirarlo. Colapsado muestra el largo acumulado en vivo — señal honesta de que
// el forge sigue pensando sin ocupar pantalla.
export function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-l border-line pl-3">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 font-tech text-sm tracking-[0.2em] text-fog/70 hover:text-fog"
      >
        <span>{"//"} THINKING</span>
        <span>{open ? "▾" : "▸"}</span>
        {!open && <span className="text-fog/50">{text.length} chars</span>}
      </button>
      {open && (
        <div className="mt-1 whitespace-pre-wrap font-tech text-base leading-relaxed text-fog">{text}</div>
      )}
    </div>
  );
}
