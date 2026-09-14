import type { NextConfig } from "next";

// Air M5 16GB: capar Turbopack para no swapear con Ollama + browser.
const nextConfig: NextConfig = {
  turbopack: { memoryLimit: 256 * 1024 * 1024 },
};

export default nextConfig;
