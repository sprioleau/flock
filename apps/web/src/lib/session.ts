import {
  SESSION_COOKIE_MAX_AGE_SECONDS,
  SESSION_COOKIE_NAME,
} from "@/lib/session-cookie";

/*
  Anonymous session identity (no-auth demo model, plan gap 4 / Phase 6.1):
  one random id per browser, created once and persisted in localStorage. It
  keys document listing/cleanup (`sessionId`) AND is the `authorId` for every
  user-authored operation, so per-user undo/redo works across tabs of the
  same browser.

  The id is also MIRRORED into a same-origin cookie (lib/session-cookie.ts)
  so server-side API routes — the chat route's generateImage executor, which
  registers library assets (Content Studio Stage S) — know which session is
  calling without any transport changes. localStorage stays the source of
  truth; the cookie is re-written on every read.
*/

const SESSION_STORAGE_KEY = "flock_session_id";

function mirrorSessionIdIntoCookie(sessionId: string): void {
  document.cookie =
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionId)}` +
    `; path=/; max-age=${SESSION_COOKIE_MAX_AGE_SECONDS}; samesite=lax`;
}

export function getOrCreateSessionId(): string {
  const existingId = window.localStorage.getItem(SESSION_STORAGE_KEY);
  if (existingId !== null && existingId.length > 0) {
    mirrorSessionIdIntoCookie(existingId);
    return existingId;
  }
  const newId = crypto.randomUUID();
  window.localStorage.setItem(SESSION_STORAGE_KEY, newId);
  mirrorSessionIdIntoCookie(newId);
  return newId;
}
