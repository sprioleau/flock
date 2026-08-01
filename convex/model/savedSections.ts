import { blockSchema } from "@flock/email-sdk";

/**
 * Saved reusable sections — shared (non-registered) helpers. The table
 * stores a section SUBTREE verbatim (flat list, root first — the
 * restoreBlocks shape) so one insert op can re-materialize it later with
 * fresh ids (apps/web/src/lib/saved-sections.ts).
 */

/**
 * Bound on one session's saved list. Saving is per human gesture (a
 * bookmark click), so demo-scale sessions sit far below this; over the
 * bound the NEWEST rows win, which is what the palette group shows anyway.
 */
export const MAX_SAVED_SECTIONS_LISTED_PER_SESSION = 50;

/** Cap on one saved subtree — far above any real section, catches garbage. */
export const MAX_BLOCKS_PER_SAVED_SECTION = 200;

/** Cap a saved-section name at a word boundary so palette cards stay readable. */
const MAX_NAME_LENGTH = 60;

export const DEFAULT_SAVED_SECTION_NAME = "Saved section";

/** The display name a saved row is seeded with. Pure — unit-tested via save. */
export function seedSavedSectionName(name: string | undefined): string {
  const trimmedName = name?.replace(/\s+/g, " ").trim() ?? "";
  if (trimmedName.length === 0) {
    return DEFAULT_SAVED_SECTION_NAME;
  }
  if (trimmedName.length <= MAX_NAME_LENGTH) {
    return trimmedName;
  }
  const slice = trimmedName.slice(0, MAX_NAME_LENGTH + 1);
  const lastSpaceIndex = slice.lastIndexOf(" ");
  return (lastSpaceIndex > 0 ? slice.slice(0, lastSpaceIndex) : slice.slice(0, MAX_NAME_LENGTH)).trimEnd();
}

/**
 * Generous caps on the LLM-authored enrichment prose (the personas
 * finding-schema truncation pattern: length guidance lives in the prompt,
 * storage truncates on receipt — one wordy generation never fails the patch).
 */
export const ENRICHMENT_TEXT_CAPS = {
  useWhen: 240,
  description: 320,
} as const;

/** Truncate at a word boundary with an ellipsis (no-op under the cap). */
export function truncateEnrichmentText({ text, cap }: { text: string; cap: number }): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= cap) {
    return collapsed;
  }
  const slice = collapsed.slice(0, cap);
  const lastSpaceIndex = slice.lastIndexOf(" ");
  return `${(lastSpaceIndex > cap * 0.6 ? slice.slice(0, lastSpaceIndex) : slice).trimEnd()}…`;
}

export type SubtreeValidationResult = { isValid: true } | { isValid: false; message: string };

/**
 * The save-time runtime guard for the `blocks` column (v.any() per the house
 * policy — the email-sdk Zod schemas are the single source of shape truth):
 *
 * 1. every entry parses against the SDK's per-type blockSchema;
 * 2. blocks[0] is a section (the subtree root restoreBlocks re-attaches);
 * 3. ids are unique, and every descendant's parentId/childrenIds pointer
 *    stays INSIDE the list (a closed subtree — nothing dangling).
 *
 * Insert-time integrity (id collisions with the target document, nesting
 * rules) is the apply engine's job; this guard only keeps garbage rows out.
 */
export function validateSavedSectionSubtree(blocks: unknown[]): SubtreeValidationResult {
  if (blocks.length === 0) {
    return { isValid: false, message: "A saved section must contain at least its section block." };
  }
  if (blocks.length > MAX_BLOCKS_PER_SAVED_SECTION) {
    return { isValid: false, message: "That section is too large to save." };
  }

  const parsedBlocks = [];
  for (const candidate of blocks) {
    const parsed = blockSchema.safeParse(candidate);
    if (!parsed.success) {
      return { isValid: false, message: "That section contains a block that isn't valid." };
    }
    parsedBlocks.push(parsed.data);
  }

  const rootBlock = parsedBlocks[0]!;
  if (rootBlock.type !== "section") {
    return { isValid: false, message: "Only whole sections can be saved." };
  }

  const idsInList = new Set<string>();
  for (const block of parsedBlocks) {
    if (idsInList.has(block.id)) {
      return { isValid: false, message: "That section's blocks aren't a valid subtree." };
    }
    idsInList.add(block.id);
  }
  for (const block of parsedBlocks) {
    const isSubtreeRoot = block.id === rootBlock.id;
    if (!isSubtreeRoot && (block.parentId === null || !idsInList.has(block.parentId))) {
      return { isValid: false, message: "That section's blocks aren't a valid subtree." };
    }
    for (const childId of block.childrenIds) {
      if (!idsInList.has(childId)) {
        return { isValid: false, message: "That section's blocks aren't a valid subtree." };
      }
    }
  }
  return { isValid: true };
}
