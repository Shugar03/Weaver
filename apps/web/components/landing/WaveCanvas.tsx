"use client";

import { useEffect, useRef } from "react";

// Ola de partículas generativa (canvas, cero assets): la red, viva.
// Pausa fuera de viewport + frame estático con reduced-motion.
export function WaveCanvas({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    let t = 0;
    let visible = true;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    function draw() {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w === 0 || h === 0) return;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const mid = h * 0.52;
      const cols = Math.floor(w / 9);
      for (let i = 0; i <= cols; i++) {
        const x = (i / cols) * w;
        const y =
          mid + Math.sin(i * 0.11 + t) * h * 0.13 + Math.sin(i * 0.031 - t * 1.4) * h * 0.24;
        const lift = Math.max(0, Math.min(1, (mid - y) / (h * 0.34) + 0.3));
        const lime = lift > 0.58;
        ctx.fillStyle = lime
          ? `rgba(208,255,0,${0.35 + lift * 0.6})`
          : `rgba(255,255,255,${0.12 + lift * 0.3})`;
        const s = 1.6 + lift * 1.8;
        ctx.fillRect(x, y, s, s);
        ctx.fillStyle = "rgba(255,255,255,0.06)";
        ctx.fillRect(x, y + 5, 1, Math.max(0, h - y - 5));
      }
      if (!reduced && visible) {
        t += 0.012;
        raf = requestAnimationFrame(draw);
      }
    }

    const io = new IntersectionObserver(([entry]) => {
      const was = visible;
      visible = entry.isIntersecting;
      if (visible && !was && !reduced) {
        cancelAnimationFrame(raf);
        draw();
      }
      if (!visible) cancelAnimationFrame(raf);
    });
    io.observe(canvas);
    draw();
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
    };
  }, []);

  return <canvas ref={ref} className={className} aria-hidden />;
}
