"use client";

import { useEffect, useState } from "react";
import PredictiveArc from "./PredictiveArc";

// Fondo del hero con la paleta Weaver. Congela el tiempo con reduced-motion
// (el arco sigue al puntero solo si el usuario lo mueve: iniciado por él).
export function HeroBackground({ className }: { className?: string }) {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    setReduced(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }, []);
  return (
    <PredictiveArc
      background="#000000"
      baseColor="#D0FF00"
      accentColor="#D9FF4D"
      highlight="#FFFFFF"
      density={150}
      dotSize={90}
      speed={reduced ? 0 : 100}
      arch={{ peak: 64, archHeight: 70, thickness: 65, falloff: 400 }}
      pointer={{ enabled: true, radius: 236, strength: 34 }}
      style={{ minWidth: 0, minHeight: 0, position: "absolute", inset: 0, width: "100%", height: "100%" }}
    />
  );
}
