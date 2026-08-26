import { defineConfig, devices } from "@playwright/test";

/*
  ===========================================================================
  THE SUITE RUNS AGAINST A SERVER THAT HOLDS NO PROVIDER KEYS. THAT IS THE
  POINT OF THIS FILE, AND IT IS THE REASON THE SUITE STARTS ITS OWN SERVER
  INSTEAD OF ATTACHING TO YOURS.
  ===========================================================================

  Flock's chat pipeline runs on a Gemini FREE TIER that is shared with
  production: 15 requests a minute, 500 a day, for the whole deployment
  (apps/web/src/app/api/chat/constants.ts records the measurement). A browser
  test that types into the studio composer is indistinguishable, at the route,
  from a paying visitor — and there is no client-side lever to force the
  deterministic mock, because the dev "mock" checkbox was removed
  (use-flock-chat.ts, `isMockEnabled`). An end-to-end suite pointed at a dev
  server holding real keys would therefore spend the live product's quota, and
  a suite that grew to a few dozen chat assertions would empty a whole day of
  it in one run.

  So the guarantee is made HERE, in deployment configuration, rather than in
  the specs. Specs are what gets edited under pressure at 2am; a `webServer`
  block is not. Three keys are blanked below, and blanking them is enough
  because of a chain that was read out of the dependencies rather than assumed:

  1. Playwright merges this `env` LAST — `{...DEFAULT_ENVIRONMENT_VARIABLES,
     ...process.env, ...options.env}` in playwright/lib/runner/index.js — so
     what is written here beats anything already exported in the shell.

  2. `@next/env` will not overwrite a variable that is already present, and
     "present" is decided with `typeof origEnv[key] === "undefined"`
     (@next/env/dist/index.js, `processEnv`). An empty string is a string, so
     `.env.local`'s real keys are NEVER applied over these. This is the load-
     bearing step and it is worth re-checking after a Next.js upgrade: if that
     guard ever becomes `=== undefined || === ""`, the blanking silently stops
     working and the suite starts spending money. The `x-flock-model`
     assertion in e2e/chat-ops.spec.ts is what catches that, which is why it
     exists.

  3. Every consumer treats "" as absent rather than as a usable key:
     api/chat/provider.ts (`readEnv` trims and requires length) falls all the
     way through to the deterministic mock, and api/chat/send-test-email.ts
     (`getResendSendConfig`) reports `not_configured` instead of dialling out.

  NEXT_PUBLIC_CONVEX_URL is deliberately NOT blanked: the studio has no
  documents without it, and Convex costs no inference. The suite's /demo
  documents land in whatever Convex deployment .env.local points at, as
  ordinary session documents that the existing 30-day cleanup sweep collects.

  `reuseExistingServer` is false and stays false. Attaching to an already-
  running `pnpm dev` would hand the suite a process holding real keys and undo
  everything above. If port 3100 is occupied, the correct outcome is the loud
  failure Playwright raises — not a quiet reuse.
*/

const E2E_PORT = 3100;
const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;

export default defineConfig({
  testDir: "./e2e",
  /*
    One worker, no parallelism. Every spec drives the same Next dev server and
    the same Convex deployment, and the persona/presence machinery is per
    document rather than per browser — parallel workers would mostly measure
    dev-server compile contention.
  */
  fullyParallel: false,
  workers: 1,
  forbidOnly: process.env.CI !== undefined,
  retries: process.env.CI !== undefined ? 1 : 0,
  reporter: [["list"]],
  /*
    Generous, because the first navigation of a run pays for an on-demand
    Turbopack compile of the whole studio route.
  */
  timeout: 90_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: E2E_BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `pnpm --filter web exec next dev --port ${E2E_PORT}`,
    url: E2E_BASE_URL,
    reuseExistingServer: false,
    timeout: 240_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      /*
        Its own build tree. Two `next dev` servers sharing one `.next` corrupt
        each other's manifests — the owner's `pnpm dev` on :3000 keeps `.next`,
        this one gets `.next-e2e` (next.config.ts reads NEXT_DIST_DIR).
      */
      NEXT_DIST_DIR: ".next-e2e",
      /* The three spend keys. See the chain above. */
      GOOGLE_GENERATIVE_AI_API_KEY: "",
      OPENROUTER_API_KEY: "",
      RESEND_API_KEY: "",
    },
  },
});
