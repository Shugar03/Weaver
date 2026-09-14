import type { NextConfig } from "next";

// Nota: `turbopack.memoryLimit` no existe en Next 16 (lo pedía el build).
// Si el dev server come mucha RAM en la Air: NODE_OPTIONS=--max-old-space-size=3072 next dev
const nextConfig: NextConfig = {};

export default nextConfig;
