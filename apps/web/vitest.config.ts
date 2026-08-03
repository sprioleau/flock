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
      // Not a real dependency — Next resolves it internally. See the stub.
      "server-only": path.resolve(__dirname, "vitest-stubs/server-only.ts"),
    },
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "node",
    env: {
      /**
       * `lib/auth/auth-server.ts` validates this at MODULE scope and throws
       * when it is missing, so any test that transitively imports a server
       * route dies on import. A syntactically valid placeholder is enough:
       * nothing here dials out — the Convex client only parses the address,
       * and every test that would otherwise reach the network stubs its
       * Convex calls.
       */
      NEXT_PUBLIC_CONVEX_URL: "https://placeholder-test.convex.cloud",
    },
  },
});
