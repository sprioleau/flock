/**
 * The anonymous session id, mirrored into a same-origin cookie (Content
 * Studio Stage S): the id lives in localStorage (lib/session.ts), which API
 * routes can't see — but the agent-path image generation runs SERVER-SIDE
 * (the chat route's generateImage executor) and must register what it
 * uploads under the calling session's library. The cookie rides every
 * same-origin fetch automatically, so the chat transport needs no body or
 * header changes.
 *
 * Shared constants + a pure parser only — importable from client and server.
 */

export const SESSION_COOKIE_NAME = "tandem_session_id";

/** One year — the cookie is re-written on every studio load anyway. */
export const SESSION_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/**
 * Extract the session id from a request's Cookie header, or null when the
 * cookie is absent/empty (e.g. a bare API call from tests). Pure — no Next
 * runtime coupling, unit-testable directly.
 */
export function getSessionIdFromCookieHeader(cookieHeader: string | null): string | null {
  if (cookieHeader === null) {
    return null;
  }
  for (const pair of cookieHeader.split(";")) {
    const separatorIndex = pair.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }
    const name = pair.slice(0, separatorIndex).trim();
    if (name !== SESSION_COOKIE_NAME) {
      continue;
    }
    const value = decodeURIComponentSafe(pair.slice(separatorIndex + 1).trim());
    return value.length > 0 ? value : null;
  }
  return null;
}

/** decodeURIComponent that returns the raw value on malformed input. */
function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
