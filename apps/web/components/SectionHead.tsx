import type { ReactNode } from "react";

// Encabezado de zona: `01 // LIVE REQUEST` — el único micro-label permitido por zona.
export function SectionHead({ index, label, right }: { index: string; label: string; right?: ReactNode }) {
  return (
    <div className="mb-6 flex items-end justify-between border-b border-line pb-3">
      <div className="font-tech text-lg tracking-[0.2em] text-fog">
        <span className="text-lima">{index}</span> {"//"} {label}
      </div>
      {right ? <div className="font-tech text-base tracking-wider text-fog">{right}</div> : null}
    </div>
  );
}
