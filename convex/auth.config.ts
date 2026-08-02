import { getAuthConfigProvider } from "@convex-dev/better-auth/auth-config";
import type { AuthConfig } from "convex/server";

/**
 * Tells Convex to accept the JWTs Better Auth mints for this deployment, which
 * is what makes `ctx.auth.getUserIdentity()` return a SERVER-VERIFIED caller
 * inside every Convex function (convex/authIdentity.ts turns that into the
 * ownership key). The issuer/JWKS are resolved from the Better Auth component
 * in the same deployment — no third-party identity provider is involved.
 */
export default {
  providers: [getAuthConfigProvider()],
} satisfies AuthConfig;
