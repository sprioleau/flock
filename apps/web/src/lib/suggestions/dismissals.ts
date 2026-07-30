/**
 * Dismissal persistence (Phase 7.3 v1): localStorage, per document. A
 * dismissed pattern key (`${blockType}|${propertyKey}` — see types.ts) never
 * re-suggests for that document, including across reloads. The §10 row 5
 * learning loop (acceptance-tuned recommendations) replaces this later.
 */

const STORAGE_KEY_PREFIX = "tandem:suggestions:dismissed:";

function getStorageKey(documentId: string): string {
  return `${STORAGE_KEY_PREFIX}${documentId}`;
}

/** The persisted dismissed pattern keys for one document (empty when unavailable). */
export function readDismissedPatternKeys(documentId: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(getStorageKey(documentId));
    if (raw === null) {
      return new Set();
    }
    const parsed: unknown = JSON.parse(raw);
    return new Set(
      Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === "string") : [],
    );
  } catch {
    // localStorage unavailable (SSR, privacy mode) or corrupt — start clean.
    return new Set();
  }
}

/** Add one dismissed pattern key for a document (best-effort persistence). */
export function persistDismissedPatternKey({
  documentId,
  patternKey,
}: {
  documentId: string;
  patternKey: string;
}): void {
  try {
    const keys = readDismissedPatternKeys(documentId);
    keys.add(patternKey);
    window.localStorage.setItem(getStorageKey(documentId), JSON.stringify([...keys]));
  } catch {
    // Best effort: the in-memory dismissal still applies for this session.
  }
}
