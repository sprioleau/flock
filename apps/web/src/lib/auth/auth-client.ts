import { convexClient } from "@convex-dev/better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { anonymousClient, magicLinkClient } from "better-auth/client/plugins";
import { AUTH_BASE_PATH } from "./config";

/*
  The browser half of the anonymous → magic-link pair. Plugin set mirrors
  convex/auth.ts exactly; a mismatch shows up as a missing method rather than
  a type error, so keep the two lists side by side when either changes.

  `basePath` points at this origin's Next route handler
  (apps/web/src/app/api/auth/[...all]/route.ts), which forwards to the Convex
  site domain. Going through our own origin is what keeps the session cookie
  first-party — a third-party cookie would be dropped outright by Safari and
  by anyone with tracking protection on.
*/
export const authClient = createAuthClient({
  basePath: AUTH_BASE_PATH,
  plugins: [convexClient(), anonymousClient(), magicLinkClient()],
});
