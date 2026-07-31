/**
 * Pure helpers for PersonaCursorOverlay (multi-agent v1 persona cursors) —
 * kept dependency-free so the deterministic-anchor contract is unit-testable
 * (vitest runs node-env, no DOM/Convex).
 */

/** FNV-1a 32-bit — deterministic anchor jitter (same hash as presence identity). */
export function hashString(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * The persona slug inside a presence userId (`persona:<slug>:<documentId>`,
 * where the slug itself may contain slashes and NO colons — see
 * convex/personas.ts buildPersonaPresenceUserId), or null for non-persona
 * roster members.
 */
export function extractPersonaSlugFromPresenceUserId(userId: string): string | null {
  const prefix = "persona:";
  if (!userId.startsWith(prefix)) {
    return null;
  }
  const lastColonIndex = userId.lastIndexOf(":");
  if (lastColonIndex <= prefix.length) {
    return null;
  }
  return userId.slice(prefix.length, lastColonIndex);
}

/**
 * Deterministic hover anchor for a finding: block-rect fractions hashed from
 * the Convex finding id, biased toward the block's right half (over the
 * content, off the leading text). Every collaborator's tab computes the SAME
 * spot — that's what keeps the hover cross-collaborator-consistent with zero
 * presence writes.
 */
export function buildFindingHoverAnchor(findingId: string): { x: number; y: number } {
  const hash = hashString(findingId);
  return {
    x: 0.55 + ((hash % 1000) / 1000) * 0.3,
    y: 0.3 + (((hash >>> 10) % 1000) / 1000) * 0.3,
  };
}

/**
 * Stable per-persona horizontal lane for the reading walk (block-rect x
 * fraction) so two personas walking at once don't stack on one point.
 */
export function buildReadingLaneX(slug: string): number {
  return 0.3 + ((hashString(slug) % 100) / 100) * 0.4;
}
