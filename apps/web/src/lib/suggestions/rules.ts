import {
  ROOT_BLOCK_ID,
  type Block,
  type BlockId,
  type EmailDocument,
  type Operation,
} from "@flock/email-sdk";
import { getAncestorIds } from "@/lib/get-ancestor-ids";
import { deriveAccentTheme } from "./derive-accent-theme";
import type {
  RecentPropertyEdit,
  Suggestion,
  SuggestionRule,
  SuggestionRuleContext,
  SuggestionRung,
} from "./types";

/**
 * The v1 deterministic rule registry (Phase 7.3). Two rules, evaluated in
 * order — the first match wins, so at most one suggestion is ever produced:
 *
 * 1. repeated-property-edit — the user set the same property to the same
 *    value on ≥ 2 blocks of one type within the recency window → offer the
 *    escalation ladder for the remaining same-type blocks (section → email),
 *    plus the confirm-gated whole-email re-theme rung when the pattern is a
 *    button recolor.
 * 2. sibling-asymmetry — rule 1's n=1 cousin: the user styled ONE block while
 *    ≥ 2 same-type siblings in the same section keep a different value →
 *    offer to match them. The ≥ 2 floor keeps it from nagging on every edit;
 *    no re-theme rung (that escalation is earned by repetition, not one edit).
 *
 * Generation is mechanical — ops and copy are composed from the pattern, no
 * model call (see types.ts for the LLM-upgrade seam).
 */

// ---------------------------------------------------------------------------
// Thresholds (tuned so the demo feels magical but normal editing isn't nagged)
// ---------------------------------------------------------------------------

/** Only the user's last N settled ops are pattern-searchable. */
export const MAX_RECENT_USER_OPS = 10;

/** ...and only when they happened within this window. */
export const RECENT_EDIT_WINDOW_MS = 2 * 60_000;

/** Rule 1: distinct same-type blocks that must share the edit. */
const MIN_REPEATED_BLOCK_COUNT = 2;

/** Rule 2: same-type section siblings that must still differ. */
const MIN_UNSTYLED_SIBLING_COUNT = 2;

// ---------------------------------------------------------------------------
// Edit eligibility & equality
// ---------------------------------------------------------------------------

/**
 * Content-carrying keys are never styling patterns — repeating a label or a
 * link across blocks is content authoring, not a theme in the making.
 */
const CONTENT_PROPERTY_KEYS: ReadonlySet<string> = new Set([
  "label",
  "href",
  "src",
  "alt",
  "text",
]);

/** Is this property edit a styling signal worth pattern-matching? */
export function isSuggestiblePropertyEdit({
  propertyKey,
  value,
}: {
  propertyKey: string;
  value: unknown;
}): boolean {
  const isScalarValue =
    typeof value === "string" || typeof value === "number" || typeof value === "boolean";
  return isScalarValue && !CONTENT_PROPERTY_KEYS.has(propertyKey);
}

function normalizePropertyValue(value: unknown): unknown {
  // Colors and other string values compare case-insensitively ("#FF0000" ≡ "#ff0000").
  return typeof value === "string" ? value.trim().toLowerCase() : value;
}

function arePropertyValuesEqual({ a, b }: { a: unknown; b: unknown }): boolean {
  return Object.is(normalizePropertyValue(a), normalizePropertyValue(b));
}

function getBlockPropertyValue({
  block,
  propertyKey,
}: {
  block: Block;
  propertyKey: string;
}): unknown {
  return (block.properties as Record<string, unknown>)[propertyKey];
}

/** Dismissal identity: block type + property, rule-agnostic (see types.ts). */
export function getPatternKey({
  blockType,
  propertyKey,
}: {
  blockType: Block["type"];
  propertyKey: string;
}): string {
  return `${blockType}|${propertyKey}`;
}

// ---------------------------------------------------------------------------
// Copy helpers — suggestions name things, never block ids
// ---------------------------------------------------------------------------

const PROPERTY_LABEL_OVERRIDES: Record<string, string> = {
  borderRadius: "corner radius",
  borderSize: "border width",
};

function getPropertyLabel(propertyKey: string): string {
  return (
    PROPERTY_LABEL_OVERRIDES[propertyKey] ??
    propertyKey.replace(/([A-Z])/g, " $1").toLowerCase()
  );
}

const BLOCK_TYPE_NOUNS: Record<Block["type"], string> = {
  root: "document",
  section: "section",
  row: "row",
  column: "column",
  text: "text block",
  button: "button",
  image: "image",
  divider: "divider",
  link: "link",
  code: "code block",
  spacer: "spacer",
};

function countNoun({ count, blockType }: { count: number; blockType: Block["type"] }): string {
  const noun = BLOCK_TYPE_NOUNS[blockType];
  return count === 1 ? noun : `${count} ${noun}s`;
}

// ---------------------------------------------------------------------------
// Structure helpers
// ---------------------------------------------------------------------------

/** The section a block lives in (null for sections themselves and the root). */
function getSectionId({ doc, blockId }: { doc: EmailDocument; blockId: BlockId }): BlockId | null {
  return getAncestorIds({ doc, blockId })[0] ?? null;
}

/** Same-type blocks whose current value for the property DIFFERS from `value`. */
function findCandidateBlocks({
  doc,
  blockType,
  propertyKey,
  value,
}: {
  doc: EmailDocument;
  blockType: Block["type"];
  propertyKey: string;
  value: unknown;
}): Block[] {
  return Object.values(doc).filter(
    (block) =>
      block.type === blockType &&
      !arePropertyValuesEqual({ a: getBlockPropertyValue({ block, propertyKey }), b: value }),
  );
}

// ---------------------------------------------------------------------------
// Ladder composition (shared by both rules)
// ---------------------------------------------------------------------------

interface ComposedLadder {
  rungs: SuggestionRung[];
  targetBlockIds: BlockId[];
}

function composeLadder({
  doc,
  anchorEdit,
  candidates,
  shouldOfferRetheme,
}: {
  doc: EmailDocument;
  anchorEdit: RecentPropertyEdit;
  candidates: Block[];
  shouldOfferRetheme: boolean;
}): ComposedLadder {
  const { blockId, blockType, propertyKey, value } = anchorEdit;
  const anchorSectionId = getSectionId({ doc, blockId });
  const sectionCandidates =
    anchorSectionId !== null
      ? candidates.filter(
          (candidate) => getSectionId({ doc, blockId: candidate.id }) === anchorSectionId,
        )
      : [];

  const composeOps = (blocks: Block[]): Operation[] =>
    blocks.map((block) => ({
      name: "updateBlockProperties",
      blockId: block.id,
      properties: { [propertyKey]: value },
    }));

  const rungs: SuggestionRung[] = [];
  const targetBlockIds = new Set<BlockId>([blockId]);

  if (sectionCandidates.length > 0) {
    rungs.push({
      id: "section",
      label: `The other ${countNoun({ count: sectionCandidates.length, blockType })} in this section`,
      ops: composeOps(sectionCandidates),
    });
  }
  if (candidates.length > sectionCandidates.length) {
    rungs.push({
      id: "email",
      label:
        sectionCandidates.length > 0
          ? `All ${countNoun({ count: candidates.length, blockType })} in the email`
          : `The other ${countNoun({ count: candidates.length, blockType })} in the email`,
      ops: composeOps(candidates),
    });
  }
  for (const candidate of candidates) {
    targetBlockIds.add(candidate.id);
  }

  // The largest rung: re-theme the whole email around the picked color.
  // Offered only for the canonical button-recolor pattern, and always
  // confirm-gated (approval semantics for whole-email scope).
  if (shouldOfferRetheme && typeof value === "string") {
    const globals = deriveAccentTheme({ doc, accentColor: value });
    if (globals !== null) {
      rungs.push({
        id: "retheme",
        label: "Re-theme the email…",
        needsConfirm: true,
        confirmDescription:
          `Restyle the whole email around ${value}: every button takes this color ` +
          "(with a readable label color), links adopt it where legible, and " +
          "per-section background overrides reset to the theme. One change — easy to revert.",
        ops: [{ name: "applyTheme", globals }],
      });
      // The re-theme payload reads the current globals, so root changes stale it.
      targetBlockIds.add(ROOT_BLOCK_ID);
    }
  }

  return { rungs, targetBlockIds: [...targetBlockIds] };
}

// ---------------------------------------------------------------------------
// Rule 1 — repeated property edit
// ---------------------------------------------------------------------------

const repeatedPropertyEditRule: SuggestionRule = {
  id: "repeated-property-edit",
  detect: (context: SuggestionRuleContext): Suggestion | null => {
    const { doc, recentEdits, anchorEdit, isPatternDismissed } = context;
    const { blockType, propertyKey, value } = anchorEdit;
    const patternKey = getPatternKey({ blockType, propertyKey });
    if (isPatternDismissed(patternKey)) {
      return null;
    }

    // Distinct blocks that (a) got this same edit recently and (b) STILL
    // carry the value now — a re-edited or reverted block is no longer part
    // of the pattern.
    const matchingBlockIds = new Set<BlockId>();
    for (const edit of recentEdits) {
      const isSameEdit =
        edit.blockType === blockType &&
        edit.propertyKey === propertyKey &&
        arePropertyValuesEqual({ a: edit.value, b: value });
      if (!isSameEdit) {
        continue;
      }
      const block = doc[edit.blockId];
      if (
        block !== undefined &&
        arePropertyValuesEqual({ a: getBlockPropertyValue({ block, propertyKey }), b: value })
      ) {
        matchingBlockIds.add(edit.blockId);
      }
    }
    if (matchingBlockIds.size < MIN_REPEATED_BLOCK_COUNT) {
      return null;
    }

    const candidates = findCandidateBlocks({ doc, blockType, propertyKey, value });
    const shouldOfferRetheme = blockType === "button" && propertyKey === "backgroundColor";
    const { rungs, targetBlockIds } = composeLadder({
      doc,
      anchorEdit,
      candidates,
      shouldOfferRetheme,
    });
    // No remaining siblings → stay quiet (a re-theme-only card would nag).
    if (!rungs.some((rung) => rung.id !== "retheme")) {
      return null;
    }

    return {
      id: crypto.randomUUID(),
      ruleId: "repeated-property-edit",
      source: "rule",
      patternKey,
      title: `Make the other ${BLOCK_TYPE_NOUNS[blockType]}s match?`,
      description: `You set the same ${getPropertyLabel(propertyKey)} on ${countNoun({
        count: matchingBlockIds.size,
        blockType,
      })}. Apply it to the rest?`,
      rungs,
      targetBlockIds,
    };
  },
};

// ---------------------------------------------------------------------------
// Rule 2 — sibling asymmetry
// ---------------------------------------------------------------------------

const siblingAsymmetryRule: SuggestionRule = {
  id: "sibling-asymmetry",
  detect: (context: SuggestionRuleContext): Suggestion | null => {
    const { doc, anchorEdit, isPatternDismissed } = context;
    const { blockId, blockType, propertyKey, value } = anchorEdit;
    const patternKey = getPatternKey({ blockType, propertyKey });
    if (isPatternDismissed(patternKey)) {
      return null;
    }

    // The styled block must still carry the value it was just given.
    const anchorBlock = doc[blockId];
    if (
      anchorBlock === undefined ||
      !arePropertyValuesEqual({
        a: getBlockPropertyValue({ block: anchorBlock, propertyKey }),
        b: value,
      })
    ) {
      return null;
    }
    const sectionId = getSectionId({ doc, blockId });
    if (sectionId === null) {
      return null; // sections themselves have no section siblings
    }

    const candidates = findCandidateBlocks({ doc, blockType, propertyKey, value });
    const sectionCandidates = candidates.filter(
      (candidate) => getSectionId({ doc, blockId: candidate.id }) === sectionId,
    );
    if (sectionCandidates.length < MIN_UNSTYLED_SIBLING_COUNT) {
      return null;
    }

    const { rungs, targetBlockIds } = composeLadder({
      doc,
      anchorEdit,
      candidates,
      shouldOfferRetheme: false,
    });
    if (!rungs.some((rung) => rung.id !== "retheme")) {
      return null;
    }

    return {
      id: crypto.randomUUID(),
      ruleId: "sibling-asymmetry",
      source: "rule",
      patternKey,
      title: `Style the other ${BLOCK_TYPE_NOUNS[blockType]}s to match?`,
      description: `${countNoun({ count: sectionCandidates.length, blockType })} in this section still ${
        sectionCandidates.length === 1 ? "has" : "have"
      } a different ${getPropertyLabel(propertyKey)}.`,
      rungs,
      targetBlockIds,
    };
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** Ordered registry — first match wins, so at most one suggestion surfaces. */
export const SUGGESTION_RULES: readonly SuggestionRule[] = [
  repeatedPropertyEditRule,
  siblingAsymmetryRule,
];

/** Run the registry over one settled gesture; null when nothing qualifies. */
export function evaluateSuggestionRules(context: SuggestionRuleContext): Suggestion | null {
  for (const rule of SUGGESTION_RULES) {
    const suggestion = rule.detect(context);
    if (suggestion !== null) {
      return suggestion;
    }
  }
  return null;
}
