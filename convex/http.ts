import { httpRouter } from "convex/server";
import { authComponent, createAuth } from "./auth";

/**
 * Flock's first HTTP router. It exists solely to host Better Auth's endpoints
 * on the Convex site domain (`*.convex.site/api/auth/*`) — sign-in, magic-link
 * verification, session and JWKS. The Next.js route at
 * `apps/web/src/app/api/auth/[...all]/route.ts` proxies same-origin browser
 * calls here so auth cookies stay first-party.
 *
 * Nothing else belongs on this router: Flock's app surface is Convex functions
 * plus Next route handlers, and the capability-URL model (a document id in the
 * URL grants access) must not acquire an HTTP shortcut.
 */
const http = httpRouter();

authComponent.registerRoutes(http, createAuth);

export default http;
