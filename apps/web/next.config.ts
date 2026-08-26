import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /*
    Build output directory, overridable per process.

    Two `next dev` servers sharing one `.next` corrupt each other's manifests
    and chunks — the second one to write wins, and the first starts serving
    404s for modules it just compiled. The e2e suite starts its own dev server
    (playwright.config.ts) alongside whatever the owner already has running on
    :3000, so it sets NEXT_DIST_DIR and gets its own tree. Unset — every
    ordinary `pnpm dev`, `next build`, and the Vercel build — is `.next`
    exactly as before.
  */
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  turbopack: {
    root: path.join(__dirname, "../.."),
  },
  // Dev-only Next.js tools launcher: bottom-left overlaps the chat composer.
  devIndicators: {
    position: "bottom-right",
  },
};

export default nextConfig;
