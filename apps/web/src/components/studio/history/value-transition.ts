import {
  DEFAULT_GLOBAL_STYLES,
  parseBlockId,
  type GlobalStyles,
  type Operation,
} from "@flock/email-sdk";
import { humanizePropertyKey } from "./property-phrases";

/**
 * Before/after glanceability for op-log rows: given one log entry's op and its
 * stored exact inverse, derive a compact typed transition the UI can render as
 * a chip (two color circles, "24 → 12px", "left → center", or a theme swatch
 * pair) — or null when a glance can't summarize the change (rich text edits,
 * structural ops, many-property updates).
 *
 * Direction convention: applying `op` took the document from state A to state
 * B and `inverse` takes it back, so BEFORE values come from the inverse
 * payload and AFTER values from the op payload. Undo/redo entries store their
 * own op/inverse pair (an undo's op IS the original edit's inverse), which
 * means the reversed display — undo of red→blue reads blue→red — falls out of
 * the same rule with no special-casing.
 *
 * Pure and framework-free on purpose: unit-tested directly, no React, no
 * Convex, no presence imports.
 */

export type ValueTransition =
  | { kind: "color"; property: string; before: string; after: string }
  | {
      kind: "number";
      property: string;
      before: number;
      after: number;
      /** Display unit implied by the property ("" when it has none). */
      unit: "px" | "%" | "";
    }
  | { kind: "text"; property: string; before: string; after: string }
  | { kind: "theme"; before: Required<GlobalStyles>; after: Required<GlobalStyles> };

/** Longest string still readable at a glance ("left", "Shop now", a hex). */
const MAX_GLANCEABLE_TEXT_LENGTH = 24;

/** Properties whose numbers are pixel values. */
const PIXEL_PROPERTY_KEYS = new Set([
  "paddingTop",
  "paddingBottom",
  "paddingLeft",
  "paddingRight",
  "horizontalPadding",
  "verticalPadding",
  "borderRadius",
  "borderSize",
  "width",
  "thickness",
  "fontSize",
  "contentWidth",
  "baseSpacing",
  "buttonBorderRadius",
  "buttonBorderSize",
  "buttonHorizontalPadding",
  "buttonVerticalPadding",
]);

/** Properties whose numbers are percentages. */
const PERCENT_PROPERTY_KEYS = new Set(["widthPercent"]);

/**
 * Above this many changed global-style keys, a root-properties swap reads as
 * a theme change and gets the swatch-pair treatment instead of per-key chips.
 */
const THEME_LIKE_CHANGED_KEY_THRESHOLD = 3;

function getNumberUnit(key: string): "px" | "%" | "" {
  if (PIXEL_PROPERTY_KEYS.has(key)) {
    return "px";
  }
  if (PERCENT_PROPERTY_KEYS.has(key)) {
    return "%";
  }
  return "";
}

/** Cheap color check: hex, rgb()/rgba(), hsl()/hsla(). */
function looksLikeColorValue(value: string): boolean {
  return (
    /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value.trim()) ||
    /^(?:rgb|rgba|hsl|hsla)\(/i.test(value.trim())
  );
}

/** Property names ending in Color are the cheap signal ("color" itself too). */
function isColorPropertyKey(key: string): boolean {
  return /color$/i.test(key);
}

interface ChangedPair {
  key: string;
  before: unknown;
  after: unknown;
}

function areValuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  // Structured values (e.g. nested objects) count as changed keys but are
  // never glanceable; a cheap JSON compare is enough to not overcount.
  if (typeof a === "object" && typeof b === "object" && a !== null && b !== null) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

/** Union-key diff of two flat records, before/after per changed key. */
function diffRecords({
  before,
  after,
}: {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}): ChangedPair[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const pairs: ChangedPair[] = [];
  for (const key of keys) {
    if (!areValuesEqual(before[key], after[key])) {
      pairs.push({ key, before: before[key], after: after[key] });
    }
  }
  return pairs;
}

/** Classify one changed pair as a glanceable transition, or null. */
function classifyPair(pair: ChangedPair): ValueTransition | null {
  const { key, before, after } = pair;
  const property = humanizePropertyKey(key);
  if (typeof before === "number" && typeof after === "number") {
    return { kind: "number", property, before, after, unit: getNumberUnit(key) };
  }
  if (typeof before !== "string" || typeof after !== "string") {
    return null;
  }
  const isColorPair =
    isColorPropertyKey(key) || (looksLikeColorValue(before) && looksLikeColorValue(after));
  if (isColorPair) {
    return { kind: "color", property, before, after };
  }
  const isShortText =
    before.length > 0 &&
    after.length > 0 &&
    before.length <= MAX_GLANCEABLE_TEXT_LENGTH &&
    after.length <= MAX_GLANCEABLE_TEXT_LENGTH &&
    !before.includes("\n") &&
    !after.includes("\n");
  return isShortText ? { kind: "text", property, before, after } : null;
}

/**
 * Chip policy over a set of changed keys: a single changed key shows its
 * transition when glanceable; a multi-key change stays with its text summary
 * UNLESS exactly one of the changed keys is a color — the one glance that
 * still pays for itself ("Updated padding and background color" + circles).
 */
function pickTransition(pairs: ChangedPair[]): ValueTransition | null {
  if (pairs.length === 0) {
    return null;
  }
  if (pairs.length === 1) {
    return classifyPair(pairs[0]!);
  }
  const colorTransitions = pairs
    .map(classifyPair)
    .filter(
      (transition): transition is Extract<ValueTransition, { kind: "color" }> =>
        transition !== null && transition.kind === "color",
    );
  return colorTransitions.length === 1 ? colorTransitions[0]! : null;
}

function withGlobalDefaults(globals: GlobalStyles | undefined): Required<GlobalStyles> {
  return { ...DEFAULT_GLOBAL_STYLES, ...(globals ?? {}) };
}

/** Loosely-shaped op accessors (log payloads arrive as unknown from Convex). */
function asOperation(raw: unknown): (Operation & Record<string, unknown>) | null {
  if (typeof raw !== "object" || raw === null || !("name" in raw)) {
    return null;
  }
  return raw as Operation & Record<string, unknown>;
}

function getProperties(op: Record<string, unknown>): Record<string, unknown> | null {
  const { properties } = op;
  return typeof properties === "object" && properties !== null
    ? (properties as Record<string, unknown>)
    : null;
}

/** Globals diff with renderer defaults filled in on BOTH sides, so a key
 *  going absent reads as "back to the default value", not a blank. */
function diffGlobals({
  before,
  after,
}: {
  before: GlobalStyles | undefined;
  after: GlobalStyles | undefined;
}): ChangedPair[] {
  return diffRecords({
    before: withGlobalDefaults(before) as Record<string, unknown>,
    after: withGlobalDefaults(after) as Record<string, unknown>,
  });
}

/** Root-vs-root properties swap: compare the globals, theme-style when big. */
function describeRootPropertiesSwap({
  beforeProperties,
  afterProperties,
}: {
  beforeProperties: Record<string, unknown>;
  afterProperties: Record<string, unknown>;
}): ValueTransition | null {
  const beforeGlobals = (beforeProperties.globals ?? {}) as GlobalStyles;
  const afterGlobals = (afterProperties.globals ?? {}) as GlobalStyles;
  const pairs = diffGlobals({ before: beforeGlobals, after: afterGlobals });
  if (pairs.length >= THEME_LIKE_CHANGED_KEY_THRESHOLD) {
    return {
      kind: "theme",
      before: withGlobalDefaults(beforeGlobals),
      after: withGlobalDefaults(afterGlobals),
    };
  }
  return pickTransition(pairs);
}

/**
 * The glanceable before→after summary of one op-log entry, or null when the
 * change doesn't reduce to a glance. `op`/`inverse` are the entry's OWN
 * payloads — pass an undo entry's own pair to get the correctly reversed
 * display.
 */
export function describeValueTransition({
  op: rawOp,
  inverse: rawInverse,
}: {
  op: unknown;
  inverse: unknown;
}): ValueTransition | null {
  const op = asOperation(rawOp);
  const inverse = asOperation(rawInverse);
  if (op === null || inverse === null) {
    return null;
  }

  // A theme apply (or its inverse re-applied by undo/redo): swatch pair.
  if (op.name === "applyTheme") {
    const beforeGlobals =
      inverse.name === "applyTheme"
        ? (inverse.globals as GlobalStyles)
        : inverse.name === "replaceBlockProperties"
          ? ((getProperties(inverse)?.globals ?? {}) as GlobalStyles)
          : null;
    if (beforeGlobals === null) {
      return null;
    }
    return {
      kind: "theme",
      before: withGlobalDefaults(beforeGlobals),
      after: withGlobalDefaults(op.globals as GlobalStyles),
    };
  }

  // Partial global-styles merge: before = inverse's root snapshot (or the
  // renderer default when the key wasn't set), after = the op's values.
  if (op.name === "updateDocumentSettings") {
    if (inverse.name !== "replaceBlockProperties") {
      return null;
    }
    const previousGlobals = withGlobalDefaults(
      (getProperties(inverse)?.globals ?? {}) as GlobalStyles,
    ) as Record<string, unknown>;
    const pairs: ChangedPair[] = [];
    for (const [key, after] of Object.entries(op.globals as Record<string, unknown>)) {
      if (after !== undefined && !areValuesEqual(previousGlobals[key], after)) {
        pairs.push({ key, before: previousGlobals[key], after });
      }
    }
    return pickTransition(pairs);
  }

  // Partial block-properties merge: before values live in the inverse's full
  // property snapshot. Keys the block didn't have before (before undefined)
  // have no glanceable "from" — classifyPair drops them.
  if (op.name === "updateBlockProperties") {
    if (inverse.name !== "replaceBlockProperties" || inverse.blockId !== op.blockId) {
      return null;
    }
    const previousProperties = getProperties(inverse);
    if (previousProperties === null) {
      return null;
    }
    const pairs: ChangedPair[] = [];
    for (const [key, after] of Object.entries(op.properties)) {
      if (after !== undefined && !areValuesEqual(previousProperties[key], after)) {
        pairs.push({ key, before: previousProperties[key], after });
      }
    }
    return pickTransition(pairs);
  }

  // Full property swaps — the shape undo/redo entries carry (an undo's op is
  // the original edit's replaceBlockProperties inverse). Diff the two
  // snapshots; on the root the diff is over globals and may be theme-sized.
  if (op.name === "replaceBlockProperties") {
    if (inverse.name !== "replaceBlockProperties" || inverse.blockId !== op.blockId) {
      return null;
    }
    const afterProperties = getProperties(op);
    const beforeProperties = getProperties(inverse);
    if (afterProperties === null || beforeProperties === null) {
      return null;
    }
    if (parseBlockId(op.blockId)?.type === "root") {
      return describeRootPropertiesSwap({ beforeProperties, afterProperties });
    }
    return pickTransition(diffRecords({ before: beforeProperties, after: afterProperties }));
  }

  // Structural ops, text edits, unknown ops: no glanceable pair.
  return null;
}

/** Raw-value tooltip text for a chip ("background color: #ff0000 → #0000ff"). */
export function formatTransitionTooltip(transition: ValueTransition): string {
  if (transition.kind === "theme") {
    return `Theme: email ${transition.before.emailBackgroundColor} / content ${transition.before.contentBackgroundColor} → email ${transition.after.emailBackgroundColor} / content ${transition.after.contentBackgroundColor}`;
  }
  if (transition.kind === "number") {
    const unitSuffix = transition.unit === "" ? "" : transition.unit;
    return `${transition.property}: ${transition.before}${unitSuffix} → ${transition.after}${unitSuffix}`;
  }
  return `${transition.property}: ${transition.before} → ${transition.after}`;
}
