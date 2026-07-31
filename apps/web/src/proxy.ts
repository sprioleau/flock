import { ConvexHttpClient } from "convex/browser";
import { NextResponse, type NextRequest } from "next/server";
import { api } from "@convex/_generated/api";
import {
  CANVAS_COOKIE_MAX_AGE_SECONDS,
  CANVAS_COOKIE_NAME,
  DOC_COOKIE_MAX_AGE_SECONDS,
  DOC_COOKIE_NAME,
  GATE_COOKIE_NAME,
  GATE_PATH,
  GATE_RETURN_TO_PARAM,
  deriveCanvasCookieValue,
  deriveDocCookieValue,
  deriveGateCookieValue,
  getAccessPassword,
  isMatchingSecret,
} from "@/lib/access-gate";

/**
 * Access gate (Next.js 16 proxy — the renamed middleware.ts convention).
 *
 * Decision matrix, evaluated per matched request:
 *   0. Gate disabled (TANDEM_ACCESS_PASSWORD unset/empty) → pass everything.
 *   1. /gate itself → pass (the password form and its server action POST).
 *   2. Valid gate cookie (HMAC derived from the password env) → pass.
 *   3. `?doc=<id>` present → capability link:
 *      a. valid short-lived per-doc cookie for that exact id → pass
 *         (skips repeat Convex lookups on hard navigations/reloads);
 *      b. otherwise validate the id against Convex (documents.documentExists);
 *         real → pass + set the per-doc cookie; bogus/deleted → fall through
 *         to the gate. (A link whose document the cleanup cron deleted lands
 *         on the gate — acceptable: the capability is gone.)
 *   4. `?canvas=<id>` present → same capability dance against
 *      documents.canvasExists with its own per-canvas cookie (a canvas link
 *      is the whole-canvas share URL; /studio resolves it to a draft).
 *   5. Otherwise → redirect to /gate?from=<original path+query>.
 *
 * Client-side note: soft navigations that only touch the URL via
 * history.replaceState (how StudioShell adopts a freshly created doc id) never
 * reach the server, so unlocked users and link-holders are not re-checked
 * mid-session; RSC fetches for real route transitions do re-run this proxy,
 * which the cookies above keep cheap.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const password = getAccessPassword();
  if (password === undefined) {
    // Gate disabled: local dev and CI pass through untouched.
    return NextResponse.next();
  }

  const { pathname, search, searchParams } = request.nextUrl;

  // The gate page (and its server-action POST) must stay reachable.
  if (pathname === GATE_PATH) {
    return NextResponse.next();
  }

  // (a) Already unlocked: gate cookie carries the HMAC of the current
  // password, so rotating the env var invalidates it automatically.
  const gateCookieValue = request.cookies.get(GATE_COOKIE_NAME)?.value;
  if (
    gateCookieValue !== undefined &&
    isMatchingSecret({
      providedValue: gateCookieValue,
      expectedValue: deriveGateCookieValue(password),
    })
  ) {
    return NextResponse.next();
  }

  // (b) Capability links: a URL carrying a valid document or canvas id
  // passes without the password — the id is the capability, same model as
  // the rest of the app. `?doc=` is checked first (the more specific link);
  // an invalid one falls through to the `?canvas=` check, then the gate.
  const documentKey = searchParams.get("doc");
  if (documentKey !== null && documentKey.length > 0) {
    const documentResponse = await passIfCapabilityIsValid({
      request,
      cookieName: DOC_COOKIE_NAME,
      cookieMaxAgeSeconds: DOC_COOKIE_MAX_AGE_SECONDS,
      expectedCookieValue: deriveDocCookieValue({ password, documentKey }),
      doesCapabilityExist: () =>
        runExistenceQuery((client) =>
          client.query(api.documents.documentExists, { documentKey }),
        ),
    });
    if (documentResponse !== null) {
      return documentResponse;
    }
    // Bogus or deleted id → fall through.
  }

  const canvasKey = searchParams.get("canvas");
  if (canvasKey !== null && canvasKey.length > 0) {
    const canvasResponse = await passIfCapabilityIsValid({
      request,
      cookieName: CANVAS_COOKIE_NAME,
      cookieMaxAgeSeconds: CANVAS_COOKIE_MAX_AGE_SECONDS,
      expectedCookieValue: deriveCanvasCookieValue({ password, canvasKey }),
      doesCapabilityExist: () =>
        runExistenceQuery((client) =>
          client.query(api.documents.canvasExists, { canvasKey }),
        ),
    });
    if (canvasResponse !== null) {
      return canvasResponse;
    }
    // Bogus or deleted id → fall through to the gate.
  }

  // (c) No credentials: send to the password page, remembering where the
  // visitor was headed so unlock can return them there.
  const gateUrl = new URL(GATE_PATH, request.url);
  gateUrl.searchParams.set(GATE_RETURN_TO_PARAM, `${pathname}${search}`);
  return NextResponse.redirect(gateUrl);
}

/**
 * One capability check (doc or canvas): pass on a valid short-lived cookie,
 * else validate against Convex and pass + set the cookie. Returns null when
 * the capability is invalid — the caller falls through toward the gate.
 */
async function passIfCapabilityIsValid({
  request,
  cookieName,
  cookieMaxAgeSeconds,
  expectedCookieValue,
  doesCapabilityExist,
}: {
  request: NextRequest;
  cookieName: string;
  cookieMaxAgeSeconds: number;
  expectedCookieValue: string;
  doesCapabilityExist: () => Promise<boolean>;
}): Promise<NextResponse | null> {
  const cookieValue = request.cookies.get(cookieName)?.value;
  const hasValidCookie =
    cookieValue !== undefined &&
    isMatchingSecret({
      providedValue: cookieValue,
      expectedValue: expectedCookieValue,
    });
  if (hasValidCookie) {
    return NextResponse.next();
  }

  if (await doesCapabilityExist()) {
    const response = NextResponse.next();
    response.cookies.set({
      name: cookieName,
      value: expectedCookieValue,
      maxAge: cookieMaxAgeSeconds,
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
    });
    return response;
  }
  return null;
}

/**
 * Existence check over Convex HTTP. Returns false (never throws) for
 * malformed ids — the existence queries normalize untrusted strings — and
 * fails CLOSED (false → gate) if Convex is unreachable.
 */
async function runExistenceQuery(
  run: (client: ConvexHttpClient) => Promise<boolean>,
): Promise<boolean> {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (convexUrl === undefined) {
    return false;
  }
  try {
    return await run(new ConvexHttpClient(convexUrl));
  } catch {
    return false;
  }
}

export const config = {
  matcher: [
    /*
     * Page routes only. Excluded on purpose:
     * - api: API routes stay OPEN. The capability model governs them (a
     *   request is only useful with a document id you already hold), and
     *   gating them would break the app for link-holders who passed the
     *   gate via ?doc=<id> — their browser calls /api/* without the gate
     *   cookie. (/gate is allowed through in code above, not here, so the
     *   check stays visible and unit-testable.)
     * - _next/static, _next/image: build assets and image optimization.
     * - favicon.ico and any path with a file extension (public/ assets).
     */
    "/((?!api|_next/static|_next/image|favicon.ico|.*\\..*).*)",
  ],
};
