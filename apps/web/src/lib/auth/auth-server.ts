import "server-only";
import { convexBetterAuthNextJs } from "@convex-dev/better-auth/nextjs";
import { AUTH_BASE_PATH } from "./config";

/**
 * Server-side auth surface: the `/api/auth/[...all]` handler plus helpers for
 * reading the caller's identity from a Next route handler or server component.
 *
 * `getToken()` is the replacement for the hand-rolled session-cookie mirror
 * (apps/web/src/lib/session-cookie.ts) once server routes move over: instead of
 * reading a JS-writable cookie the client set, a route asks for the caller's
 * signed Convex token and lets Convex verify it. The mirror is still in place
 * — /api/chat and /api/saved-sections/enrich read it today — because those
 * routes belong to other work in flight; see the implementation notes for the
 * exact swap.
 */
const { convexUrl, convexSiteUrl } = readConvexUrls();

export const {
  handler,
  getToken,
  isAuthenticated,
  preloadAuthQuery,
  fetchAuthQuery,
  fetchAuthMutation,
  fetchAuthAction,
} = convexBetterAuthNextJs({
  convexUrl,
  convexSiteUrl,
  basePath: AUTH_BASE_PATH,
});

/**
 * The site URL is derivable from the cloud URL, so a missing
 * NEXT_PUBLIC_CONVEX_SITE_URL is recoverable rather than fatal — one less env
 * var for a deploy to get wrong. A missing cloud URL is not recoverable.
 */
function readConvexUrls(): { convexUrl: string; convexSiteUrl: string } {
  const cloudUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (cloudUrl === undefined || cloudUrl === "") {
    throw new Error("Convex is not configured (NEXT_PUBLIC_CONVEX_URL is not set).");
  }
  const siteUrl =
    process.env.NEXT_PUBLIC_CONVEX_SITE_URL ??
    cloudUrl.replace(".convex.cloud", ".convex.site");
  return { convexUrl: cloudUrl, convexSiteUrl: siteUrl };
}
