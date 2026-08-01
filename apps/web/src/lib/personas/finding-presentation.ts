/**
 * Multi-agent canvas — the shared timing contract for the persona "found
 * something" beat (owner feedback 2026-07-31: the flow must read as
 * wander → dwell-hover on the found block → select it → the recommendation
 * posts; previously the card, the presence selection, and the cursor all
 * landed in the same instant).
 *
 * All offsets are measured from the finding's SERVER-STAMPED `createdAtMs`
 * (personaFindings.recordFindings), the same shared clock the cursor
 * presentation already uses — every collaborator's tab derives the same
 * beats with zero extra presence writes. Kept dependency-free so the
 * choreography contract is unit-testable (vitest node-env).
 */

/**
 * How long the persona cursor dwell-hovers over the found block before it
 * SELECTS it (presence-level selection chrome becomes visible). The visible
 * "it found something there" beat — owner spec: a couple of seconds.
 */
export const FINDING_DWELL_MS = 2_400;

/**
 * When the recommendation CARD becomes visible (the "posts to chat" moment),
 * measured from `createdAtMs`: just after the select lands, so the human
 * connects the persona's motion to the message. Must be ≥ FINDING_DWELL_MS.
 */
export const FINDING_CARD_REVEAL_MS = 3_000;

/** The instant a finding's card may surface (see FINDING_CARD_REVEAL_MS). */
export function getFindingCardRevealAtMs({
  findingCreatedAtMs,
}: {
  findingCreatedAtMs: number;
}): number {
  return findingCreatedAtMs + FINDING_CARD_REVEAL_MS;
}
