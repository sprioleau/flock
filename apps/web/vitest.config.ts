import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Unit tests for the web app's pure presentation helpers (no DOM, no Convex).
 * The "@/" alias mirrors tsconfig so helpers may import app-local modules.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@convex": path.resolve(__dirname, "../../convex"),
    },
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "node",
  },
});
