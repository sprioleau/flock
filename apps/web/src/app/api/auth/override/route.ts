import { cookies } from "next/headers";
import {
  OWNER_OVERRIDE_COOKIE_MAX_AGE_SECONDS,
  OWNER_OVERRIDE_COOKIE_NAME,
  deriveOwnerOverrideCookieValue,
  getOwnerOverridePassword,
  hasOwnerOverride,
  isMatchingOverrideSecret,
} from "@/lib/auth/owner-override";

/*
  POST /api/auth/override — redeem the owner override password for an
  uncapped credit allowance. DELETE gives it back. GET reports whether the
  caller already holds one.

  The expected value never leaves the server; the response says only "yes" or
  "no". A wrong password and a disabled feature return the SAME 403 with the
  same message, so probing cannot tell whether an override even exists on this
  deployment.

  Brute-force bound: a small per-IP attempt limiter in front of the compare.
  In-memory and therefore per-instance — enough to make a scripted guessing
  run impractical against a demo deployment, and honest about being a speed
  bump rather than a distributed rate limiter. The real protection is a long
  random secret.
*/

const MAX_ATTEMPTS_PER_WINDOW = 5;
const ATTEMPT_WINDOW_MS = 60_000;

const attemptsByClient = new Map<string, { count: number; windowStartMs: number }>();

function isRateLimited(clientKey: string): boolean {
  const nowMs = Date.now();
  const entry = attemptsByClient.get(clientKey);
  if (entry === undefined || nowMs - entry.windowStartMs >= ATTEMPT_WINDOW_MS) {
    attemptsByClient.set(clientKey, { count: 1, windowStartMs: nowMs });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_ATTEMPTS_PER_WINDOW;
}

/*
  GET /api/auth/override — does THIS browser already hold a valid override?

  The UI needs the answer twice (the /override page, so it can offer to give
  the override back rather than ask for a password nobody needs to retype; and
  the settings menu, so the owner-only provider control can be absent rather
  than merely disabled). Without this, the only way to know was to try a
  password, which is exactly the thing worth not doing casually.

  Deliberately NOT run through `isRateLimited`. That limiter exists to bound
  guessing, and this endpoint offers nothing to guess at: it reads a cookie
  the caller already has and returns a boolean about it. Metering it would
  only mean a page refresh could lock the owner out of their own UI.

  What it discloses: `true` implies the feature is configured here — but a
  caller can only get `true` by already holding a valid cookie, which they
  could only have obtained by knowing the password. `false` is returned
  identically whether the password is wrong, the cookie is stale, or the
  feature was never switched on for this deployment, preserving the same
  ambiguity POST is careful about.

  `no-store` is load-bearing, not hygiene: the answer varies per cookie, and a
  shared cache that kept one `true` would hand an override's UI to strangers.
*/
export function GET(request: Request): Response {
  const isUnlocked = hasOwnerOverride(request.headers.get("cookie"));
  return Response.json({ isUnlocked }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request): Promise<Response> {
  const clientKey =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (isRateLimited(clientKey)) {
    return Response.json(
      { isUnlocked: false, message: "Too many attempts. Wait a minute and try again." },
      { status: 429 },
    );
  }

  let submittedPassword = "";
  try {
    const body: unknown = await request.json();
    submittedPassword = String((body as { password?: unknown })?.password ?? "");
  } catch {
    submittedPassword = "";
  }

  const password = getOwnerOverridePassword();
  const isUnlocked =
    password !== undefined &&
    submittedPassword.length > 0 &&
    isMatchingOverrideSecret({
      providedValue: submittedPassword,
      expectedValue: password,
    });

  if (!isUnlocked) {
    return Response.json(
      { isUnlocked: false, message: "That password didn't match." },
      { status: 403 },
    );
  }

  const cookieStore = await cookies();
  cookieStore.set({
    name: OWNER_OVERRIDE_COOKIE_NAME,
    value: deriveOwnerOverrideCookieValue(password),
    maxAge: OWNER_OVERRIDE_COOKIE_MAX_AGE_SECONDS,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  });
  return Response.json({ isUnlocked: true, message: "Credit limit lifted on this browser." });
}

export async function DELETE(): Promise<Response> {
  const cookieStore = await cookies();
  cookieStore.delete(OWNER_OVERRIDE_COOKIE_NAME);
  return Response.json({ isUnlocked: false, message: "Credit limit restored." });
}
