import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Shared logic for the access gate. Used by the proxy (src/proxy.ts) and the
 * gate page's server action (src/app/gate/actions.ts) — both run on the
 * Node.js runtime, so node:crypto is available.
 *
 * Cookie scheme: the gate cookie's value is an HMAC derived from the
 * TANDEM_ACCESS_PASSWORD env var (never the raw password). Rotating the env
 * var changes the expected HMAC, which invalidates every outstanding cookie
 * automatically — no server-side session state needed.
 */

export const GATE_COOKIE_NAME = "tandem_access";
export const GATE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // ~30 days

/**
 * Short-lived companion cookie set after a successful `?doc=<id>` existence
 * check. It is scoped to that one document id (the id is baked into the
 * HMAC), so it only skips repeat Convex lookups for the same capability link
 * — it never unlocks the bare entry pages the password protects.
 */
export const DOC_COOKIE_NAME = "tandem_doc_ok";
export const DOC_COOKIE_MAX_AGE_SECONDS = 60 * 60; // 1 hour

export const GATE_PATH = "/gate";
/** Query param on /gate carrying the originally-requested URL. */
export const GATE_RETURN_TO_PARAM = "from";
export const DEFAULT_RETURN_TO_PATH = "/studio";

/**
 * The gate password. `undefined` (or empty) means the gate is DISABLED and
 * every request passes — local dev and CI stay frictionless; prod opts in by
 * setting the env var. Read server-side only.
 */
export function getAccessPassword(): string | undefined {
  const password = process.env.TANDEM_ACCESS_PASSWORD;
  return password !== undefined && password.length > 0 ? password : undefined;
}

/**
 * Constant-time string comparison. Both inputs are hashed first so lengths
 * always match (timingSafeEqual throws on unequal lengths, and comparing raw
 * strings would leak length information).
 */
export function isMatchingSecret({
  providedValue,
  expectedValue,
}: {
  providedValue: string;
  expectedValue: string;
}): boolean {
  const providedDigest = createHash("sha256").update(providedValue).digest();
  const expectedDigest = createHash("sha256").update(expectedValue).digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

/** The value stored in the gate cookie for a given password. */
export function deriveGateCookieValue(password: string): string {
  return createHmac("sha256", password)
    .update("tandem-access-gate-v1")
    .digest("hex");
}

/** The value stored in the per-document cookie for a given password + doc id. */
export function deriveDocCookieValue({
  password,
  documentKey,
}: {
  password: string;
  documentKey: string;
}): string {
  return createHmac("sha256", password)
    .update(`tandem-doc-ok-v1:${documentKey}`)
    .digest("hex");
}

/**
 * Sanitize the post-unlock destination. Only same-origin absolute paths are
 * allowed (must start with "/", must not start with "//" — a protocol-relative
 * external URL); anything else falls back to /studio.
 */
export function resolveReturnToPath(rawValue: unknown): string {
  if (
    typeof rawValue === "string" &&
    rawValue.startsWith("/") &&
    !rawValue.startsWith("//")
  ) {
    return rawValue;
  }
  return DEFAULT_RETURN_TO_PATH;
}
