import { cookies } from "next/headers";
import {
  OWNER_OVERRIDE_COOKIE_MAX_AGE_SECONDS,
  OWNER_OVERRIDE_COOKIE_NAME,
  deriveOwnerOverrideCookieValue,
  getOwnerOverridePassword,
  isMatchingOverrideSecret,
} from "@/lib/auth/owner-override";

/**
 * POST /api/auth/override — redeem the owner override password for an
 * uncapped credit allowance. DELETE gives it back.
 *
 * The expected value never leaves the server; the response says only "yes" or
 * "no". A wrong password and a disabled feature return the SAME 403 with the
 * same message, so probing cannot tell whether an override even exists on this
 * deployment.
 *
 * Brute-force bound: a small per-IP attempt limiter in front of the compare.
 * In-memory and therefore per-instance — enough to make a scripted guessing
 * run impractical against a demo deployment, and honest about being a speed
 * bump rather than a distributed rate limiter. The real protection is a long
 * random secret.
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
