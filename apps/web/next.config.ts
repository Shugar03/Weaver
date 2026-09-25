import type { NextConfig } from "next";

// Nota: `turbopack.memoryLimit` no existe en Next 16 (lo pedía el build).
// Si el dev server come mucha RAM en la Air: NODE_OPTIONS=--max-old-space-size=3072 next dev
const nextConfig: NextConfig = {
  // Devin/browser previews sirven la app desde 127.0.0.1:<puerto>: sin esto
  // Next 16 bloquea los recursos dev (_next/*, HMR) y la página no hidrata.
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
