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
 * Is this request signed in? The ONE answer both sides of the front door use:
 * `/` decides whether to show the login panel, and `/dashboard` decides
 * whether to send you there. They must agree — two surfaces disagreeing about
 * who is allowed in is how the retired access gate went wrong (see the note in
 * app/page.tsx), and here it would be worse than a wrong answer: a
 * disagreement is a redirect loop.
 *
 * An unreachable or misconfigured auth backend answers "no" rather than
 * throwing. That strands nobody: `/` shows its two working buttons, and
 * `/dashboard` forwards to `/`. The loop is impossible in that state precisely
 * because both pages take the answer from here.
 */
export async function isAuthenticatedSafely(): Promise<boolean> {
  try {
    return await isAuthenticated();
  } catch {
    return false;
  }
}

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
