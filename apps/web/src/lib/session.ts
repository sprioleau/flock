/**
 * Anonymous session identity (no-auth demo model, plan gap 4 / Phase 6.1):
 * one random id per browser, created once and persisted in localStorage. It
 * keys document listing/cleanup (`sessionId`) AND is the `authorId` for every
 * user-authored operation, so per-user undo/redo works across tabs of the
 * same browser.
 */

const SESSION_STORAGE_KEY = "tandem_session_id";

export function getOrCreateSessionId(): string {
  const existingId = window.localStorage.getItem(SESSION_STORAGE_KEY);
  if (existingId !== null && existingId.length > 0) {
    return existingId;
  }
  const newId = crypto.randomUUID();
  window.localStorage.setItem(SESSION_STORAGE_KEY, newId);
  return newId;
}
