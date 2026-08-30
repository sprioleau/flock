import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/*
  The owner's bypass of the credit cap.

  NAMING, deliberately: this is `FLOCK_OWNER_OVERRIDE_PASSWORD`, NOT
  `FLOCK_ACCESS_PASSWORD`. They are two different concepts and conflating them
  would be a real footgun:

    FLOCK_ACCESS_PASSWORD    — admission. "May you use Flock at all?" Shared
                               with everyone invited to the preview.
    FLOCK_OWNER_OVERRIDE_    — privilege. "May you spend the API key without
    PASSWORD                   a limit?" Held by one person.

  Reusing the access password would hand every previewer an uncapped key the
  moment they guessed the two were the same. Separate secret, separate cookie,
  separate name.

  Trust model, mirroring the access gate (apps/web/src/lib/access-gate.ts) so
  there is one cookie scheme in the codebase rather than two:
  - The expected value NEVER reaches the client. Verification is server-side.
  - The cookie stores an HMAC derived from the secret, not the secret.
    Rotating the env var invalidates every outstanding override immediately.
  - Comparison is constant-time over hashed inputs, so neither the value nor
    its length leaks through timing.
  - Brute force is bounded by a per-IP attempt limiter at the route
    (apps/web/src/app/api/auth/override/route.ts), not by secrecy alone.
*/

export const OWNER_OVERRIDE_COOKIE_NAME = "flock_owner_override";
export const OWNER_OVERRIDE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

/*
  The override secret, or undefined when the feature is switched off entirely.
  An unset variable means NO override exists — never "the empty string works".
*/
export function getOwnerOverridePassword(): string | undefined {
  const password = process.env.FLOCK_OWNER_OVERRIDE_PASSWORD;
  return password !== undefined && password.length > 0 ? password : undefined;
}

/*
  The cookie value proving the override, derived from the secret.
*/
export function deriveOwnerOverrideCookieValue(password: string): string {
  return createHmac("sha256", password).update("owner-override:v1").digest("hex");
}

/*
  Constant-time equality. Both sides are hashed to a fixed width first, so
  `timingSafeEqual` never sees mismatched lengths (which would throw and, in
  throwing, leak the length).
*/
export function isMatchingOverrideSecret(args: {
  providedValue: string;
  expectedValue: string;
}): boolean {
  const providedDigest = createHash("sha256").update(args.providedValue).digest();
  const expectedDigest = createHash("sha256").update(args.expectedValue).digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

/*
  Does this request carry a valid override? Pure over a cookie header so it is
  unit-testable without a Next runtime.
*/
export function hasOwnerOverride(cookieHeader: string | null): boolean {
  const password = getOwnerOverridePassword();
  if (password === undefined || cookieHeader === null) {
    return false;
  }
  const cookieValue = readCookie({
    cookieHeader,
    name: OWNER_OVERRIDE_COOKIE_NAME,
  });
  if (cookieValue === null) {
    return false;
  }
  return isMatchingOverrideSecret({
    providedValue: cookieValue,
    expectedValue: deriveOwnerOverrideCookieValue(password),
  });
}

function readCookie(args: { cookieHeader: string; name: string }): string | null {
  for (const pair of args.cookieHeader.split(";")) {
    const separatorIndex = pair.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }
    if (pair.slice(0, separatorIndex).trim() !== args.name) {
      continue;
    }
    const value = pair.slice(separatorIndex + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}
