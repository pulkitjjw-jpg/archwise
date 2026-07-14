import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emits .next/standalone -- a minimal, self-contained server bundle (only the deps this app
  // actually uses at runtime, not the full node_modules tree) that a Docker image can COPY and
  // run directly with `node server.js`, no `npm install` needed inside the final image. Doesn't
  // change `next dev`/local behavior at all -- purely additive to what `next build` emits.
  output: "standalone",
};

export default nextConfig;
