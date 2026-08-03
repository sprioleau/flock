/**
 * Pure presentation helpers for the dashboard cards.
 *
 * Split out from the components so the wording rules — which are the part a
 * person actually reads — can be pinned by tests without mounting React or
 * standing up Convex.
 */

/** Milliseconds in the units the card counts up through. */
const MS_PER_MINUTE = 60 * 1000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/**
 * How long ago something happened, in the shape a person would say it.
 *
 * `nowMs` is a parameter rather than a `Date.now()` call so the output is
 * deterministic under test. Deliberately coarse: a dashboard card wants "this
 * morning" precision, not seconds, and a ticking timestamp is noise on a page
 * whose job is orientation.
 *
 * Beyond a week it becomes an absolute date — "23 days ago" is arithmetic the
 * reader has to do, while "12 Mar" is just the answer.
 */
export function formatRelativeTime({
  timestampMs,
  nowMs,
}: {
  timestampMs: number;
  nowMs: number;
}): string {
  const elapsedMs = nowMs - timestampMs;

  // A clock skew (or a row written a moment "ahead") must not render as
  // "-3 minutes ago"; anything not yet in the past reads as current.
  if (elapsedMs < MS_PER_MINUTE) {
    return "Just now";
  }
  if (elapsedMs < MS_PER_HOUR) {
    const minutes = Math.floor(elapsedMs / MS_PER_MINUTE);
    return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  }
  if (elapsedMs < MS_PER_DAY) {
    const hours = Math.floor(elapsedMs / MS_PER_HOUR);
    return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  }
  const days = Math.floor(elapsedMs / MS_PER_DAY);
  if (days === 1) {
    return "Yesterday";
  }
  if (days < 7) {
    return `${days} days ago`;
  }
  return new Date(timestampMs).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(new Date(timestampMs).getFullYear() === new Date(nowMs).getFullYear()
      ? {}
      : { year: "numeric" }),
  });
}

/** "1 draft" / "4 drafts" — the count with its unit, never a bare number. */
export function formatDraftCount(draftCount: number): string {
  return draftCount === 1 ? "1 draft" : `${draftCount} drafts`;
}

/**
 * Where a card click goes.
 *
 * Prefers the canvas's most recently touched draft (`?doc=`) so the user lands
 * exactly where they left off. Falls back to the canvas link (`?canvas=`),
 * which the studio route resolves server-side — that path exists for the
 * moment a canvas has drafts the list read could not resolve, and it is the
 * same link the studio's own "Copy canvas link" hands out.
 */
export function buildCanvasHref({
  canvasId,
  entryDocumentId,
}: {
  canvasId: string;
  entryDocumentId: string | null;
}): string {
  return entryDocumentId === null
    ? `/studio?canvas=${encodeURIComponent(canvasId)}`
    : `/studio?doc=${encodeURIComponent(entryDocumentId)}`;
}

/**
 * The extra-drafts pill on a card ("+2 more"), or null when every draft is
 * already shown. Returning null rather than an empty string keeps the
 * "render nothing" decision at the call site's boundary instead of relying on
 * an empty span being invisible.
 */
export function formatHiddenDraftCount({
  draftCount,
  shownCount,
}: {
  draftCount: number;
  shownCount: number;
}): string | null {
  const hiddenCount = draftCount - shownCount;
  return hiddenCount > 0 ? `+${hiddenCount} more` : null;
}
