import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    root: path.join(__dirname, "../.."),
  },
  // Dev-only Next.js tools launcher: bottom-left overlaps the chat composer.
  devIndicators: {
    position: "bottom-right",
  },
};

export default nextConfig;
