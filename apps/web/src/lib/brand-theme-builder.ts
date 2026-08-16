/*
  User-authored themes: FILTER-BEFORE-OFFERING, plus shuffle
  (docs/proposals/brand-kit-v2-themes-fonts-and-logo.md §2.1).

  The owner's ask was "the user should be able to set it up themselves or
  possibly even shuffle through the colors, making sure to ONLY PROVIDE colors
  that have good color contrast". The emphasis is the whole design: today the
  server gate (`getBrandKitValidationErrors`) REFUSES a kit whose pairings miss
  WCAG-AA, which means a picker that offered every color would let a person
  assemble a theme and only then be told no. This module inverts that — the
  eligible set for a chosen background is computed FIRST, so a failing
  combination is never on screen. The server gate stays exactly where it is; it
  becomes the backstop that guarantees no failing kit is ever stored regardless
  of client, rather than the user's experience of the feature.

  WHAT THIS MODULE BUILDS, AND WHAT NOW SITS BESIDE IT: it composes theme
  PAYLOADS and does not care whether they are appended or written over an
  existing variation.

  ~~It never edits an existing variation, because editing a variation's globals
  DETACHES every draft rendering it.~~ That blocker is resolved
  (brand-kit-user-control.md §14.5a): identity resolves `matched payload →
  surviving pointer → none`, per-property overrides are diffed against the
  baseline snapshot on `documents.brand`, and `updateBrandThemeVariation` in
  convex/brandKits.ts is the edit path. An edit bumps the kit revision, so
  referencing drafts read "outdated" and grow the normal non-blocking pill;
  confirming it adopts the new payload while keeping each draft's own
  overridden properties. Appending still does not bump — see both mutations'
  comments for the two halves of that policy.

  Pure by design (no React, no DOM, no ctx): apps/web/vitest.config.ts pins
  `environment: "node"` for all of src/**, so the decision logic — eligibility,
  candidate generation, shuffle ordering, naming, id uniqueness — lives here
  with real unit tests, and BrandThemeBuilder.tsx stays a thin renderer.
*/

import { DEFAULT_GLOBAL_STYLES, type GlobalStyles } from "@flock/email-sdk";
import {
  getContrastRatio,
  MIN_THEME_CONTRAST_RATIO,
  type BrandColor,
  type BrandKitFonts,
  type ThemeVariation,
} from "./brand-kit";
import { mixHexColors } from "./brand-kit-extraction/color-utils";
import {
  BUTTON_SHAPE_RADII,
  expandSemanticVariation,
  slugify,
  type ButtonShape,
} from "./brand-kit-extraction/expand-variations";

/*
  The colors a person picks for one custom theme, in the roles §2 of the
  proposal already named. Nothing here is invented: it is the same semantic
  shape the scrape's own `SemanticVariation` carries, so a user-authored theme
  and a scraped one expand through ONE code path
  ({@link expandSemanticVariation}) and cannot drift apart.

  `accent` is the one that matters most and is easiest to forget: it becomes
  `buttonBackgroundColor` (and the link color), which is what makes the owner's
  "I also want these colors to inform the buttons" true for a hand-built theme.
  A theme that left it out would silently keep the renderer's black/white
  button defaults — broken in exactly the place a reader clicks.
*/
export interface ThemeColorRoles {
  /* The content surface — the color everything else is judged against. */
  contentBackground: string;
  headingText: string;
  paragraphText: string;
  /* Buttons and links. */
  accent: string;
}

/* One offered theme: the picked roles plus a stable key for list rendering. */
export interface ThemeCandidate {
  /* Stable within one candidate set — the shuffle's cursor. */
  key: string;
  roles: ThemeColorRoles;
}

/* Every distinct, readable hex in the kit's authored palette, in panel order. */
export function getPaletteHexes(colors: BrandColor[] | undefined): string[] {
  const seen = new Set<string>();
  const hexes: string[] = [];
  for (const color of colors ?? []) {
    const normalized = normalizeHex(color.hex);
    if (normalized === null || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    hexes.push(normalized);
  }
  return hexes;
}

/* Lowercased #rrggbb, or null when the value is not hex we can read. */
function normalizeHex(hex: string): string | null {
  const raw = hex.trim().replace(/^#/, "");
  const isShort = /^[0-9a-f]{3}$/i.test(raw);
  const isLong = /^[0-9a-f]{6}$/i.test(raw);
  if (!isShort && !isLong) {
    return null;
  }
  const full = isShort ? [...raw].map((character) => character + character).join("") : raw;
  return `#${full.toLowerCase()}`;
}

function passesContrast({ foreground, background }: { foreground: string; background: string }): boolean {
  const ratio = getContrastRatio({ foreground, background });
  return ratio !== null && ratio >= MIN_THEME_CONTRAST_RATIO;
}

/*
  THE filter. The text colors from the palette that are legible on `background`
  — the only ones a text picker may offer for it. A color is never eligible
  against itself, so an all-one-color theme cannot be assembled.
*/
export function getEligibleTextColors({
  background,
  paletteHexes,
}: {
  background: string;
  paletteHexes: string[];
}): string[] {
  const normalizedBackground = normalizeHex(background);
  if (normalizedBackground === null) {
    return [];
  }
  return paletteHexes.filter(
    (candidate) =>
      candidate !== normalizedBackground &&
      passesContrast({ foreground: candidate, background: normalizedBackground }),
  );
}

/*
  The backgrounds worth offering: the ones that have at least one legible text
  color. Filtering the BACKGROUND list too is what keeps the picker from
  walking the user into a dead end — the §2.1 note about "the eligible set may
  be empty, and the UI must have an answer". A monochrome palette (three close
  mid-greys) legitimately produces an EMPTY array here, and the builder says so
  in words rather than showing a shuffle button that can never land.
*/
export function getEligibleThemeBackgrounds(paletteHexes: string[]): string[] {
  return paletteHexes.filter(
    (background) => getEligibleTextColors({ background, paletteHexes }).length > 0,
  );
}

/*
  The email (outer) background: the content surface nudged a little toward its
  own body text. Derived rather than picked because it carries no contrast
  pairing of its own (`getVariationContrastPairs` does not guard it), so
  offering it as a fifth choice would spend the user's attention on the one
  decision that cannot be gotten wrong — while a flat outer color would lose
  the framed look every scraped variation has. 8% keeps light themes light and
  dark themes dark.
*/
export function deriveEmailBackgroundColor({
  contentBackground,
  paragraphText,
}: {
  contentBackground: string;
  paragraphText: string;
}): string {
  return mixHexColors({ base: contentBackground, target: paragraphText, amount: 0.08 });
}

/*
  How many candidates one shuffle set holds. The palette is capped at 12
  colors, so the raw cross-product is bounded but still larger than anyone
  wants to cycle; this keeps a shuffle finite and the memoized set cheap.
*/
export const MAX_THEME_CANDIDATES = 48;

/*
  Every theme worth offering, ALL of which pass contrast by construction.

  The generation rule is deliberately not the full cross-product of four
  roles: heading and paragraph text are chosen for the background rather than
  enumerated, because a shuffle whose stops differ only in which of two
  near-identical dark greys the paragraphs use is not a shuffle a person can
  perceive. What varies between stops is what a reader actually sees — the
  background and the accent.

  Heading takes the HIGHEST-contrast eligible color (headings should punch),
  paragraph the next one down when there is one (the softer body color every
  scraped variation has), falling back to the heading color for a two-color
  palette. The accent is unconstrained: `expandSemanticVariation` derives the
  button label from it with `pickButtonLabelColor` and repairs the link color
  against the content background, exactly as it does for the scrape — so every
  accent in the palette is safe, and the button keeps the brand's raw color
  instead of a washed-out repaired one.
*/
export function buildThemeCandidates(paletteHexes: string[]): ThemeCandidate[] {
  const candidates: ThemeCandidate[] = [];
  for (const contentBackground of getEligibleThemeBackgrounds(paletteHexes)) {
    const eligibleText = [...getEligibleTextColors({ background: contentBackground, paletteHexes })].sort(
      (a, b) =>
        (getContrastRatio({ foreground: b, background: contentBackground }) ?? 0) -
        (getContrastRatio({ foreground: a, background: contentBackground }) ?? 0),
    );
    const headingText = eligibleText[0];
    if (headingText === undefined) {
      continue;
    }
    const paragraphText = eligibleText[1] ?? headingText;
    for (const accent of paletteHexes) {
      if (accent === contentBackground) {
        continue; // An invisible button is not a theme.
      }
      if (candidates.length >= MAX_THEME_CANDIDATES) {
        return candidates;
      }
      candidates.push({
        key: `${contentBackground}|${accent}`,
        roles: { contentBackground, headingText, paragraphText, accent },
      });
    }
  }
  return candidates;
}

/*
  The shuffle step: a random candidate that is NOT the one already showing, so
  every press visibly moves. Deterministic in `randomValue` (0 ≤ v < 1) so the
  ordering is unit-testable — the component supplies `Math.random()`.

  Safe by construction because the set it draws from was filtered first: there
  is no "shuffle landed on a failing pair and then refused to save" state,
  which is the failure that would have made the affordance worse than nothing.
*/
export function pickNextThemeCandidate({
  candidates,
  currentKey,
  randomValue,
}: {
  candidates: ThemeCandidate[];
  currentKey: string | null;
  randomValue: number;
}): ThemeCandidate | null {
  const choices = candidates.filter((candidate) => candidate.key !== currentKey);
  if (choices.length === 0) {
    /* Nothing else to move to: keep showing the current one rather than */
    /* clearing the preview (one-candidate palettes are real). */
    return candidates.find((candidate) => candidate.key === currentKey) ?? null;
  }
  const index = Math.min(choices.length - 1, Math.max(0, Math.floor(randomValue * choices.length)));
  return choices[index] ?? null;
}

/*
  A default name built from what the user actually picked, using the kit's own
  color names ("Ink & Banana") — the palette is already named by a human or by
  the naming ladder, so a theme named from it reads like something a person
  would have written. Always editable before it is added.
*/
export function buildCustomThemeName({
  backgroundName,
  accentName,
}: {
  backgroundName: string | undefined;
  accentName: string | undefined;
}): string {
  const parts = [backgroundName, accentName]
    .map((part) => (part ?? "").trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) {
    return "Custom theme";
  }
  return parts.join(" & ");
}

/* The palette name for a hex, when the kit has one — otherwise undefined. */
export function findPaletteColorName({
  hex,
  colors,
}: {
  hex: string;
  colors: BrandColor[] | undefined;
}): string | undefined {
  const normalized = normalizeHex(hex);
  return (colors ?? []).find((color) => normalizeHex(color.hex) === normalized)?.name;
}

/*
  A variation id that is unique within the kit. Ids are how
  `findMatchingVariation`, the advisory draft pointer and the propagation
  target all address a theme, so a collision would make two themes
  indistinguishable to Stage M — hence a suffix rather than a silent overwrite.
*/
export function buildUniqueVariationId({
  name,
  takenIds,
}: {
  name: string;
  takenIds: string[];
}): string {
  const base = slugify(name);
  const taken = new Set(takenIds);
  if (!taken.has(base)) {
    return base;
  }
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) {
    suffix += 1;
  }
  return `${base}-${suffix}`;
}

/*
  The button shape a custom theme should inherit: whatever the kit's existing
  themes already use. A hand-built theme that suddenly squared off a brand's
  pill buttons would read as a bug, and button radius is not one of the four
  things the owner asked the user to choose.
*/
export function getButtonShapeFromRadius(radius: number | undefined): ButtonShape {
  if (radius === undefined) {
    return "rounded";
  }
  const entries = Object.entries(BUTTON_SHAPE_RADII) as [ButtonShape, number][];
  let closest: ButtonShape = "rounded";
  let smallestDistance = Number.POSITIVE_INFINITY;
  for (const [shape, shapeRadius] of entries) {
    const distance = Math.abs(shapeRadius - radius);
    if (distance < smallestDistance) {
      smallestDistance = distance;
      closest = shape;
    }
  }
  return closest;
}

/*
  Expand a user's picks into the complete `Required<GlobalStyles>` payload a
  variation must carry, THROUGH the scrape's own expander. That reuse is the
  point: buttons take the accent, the button label is derived for legibility,
  the link color is repaired against the content background, layout keys hold
  renderer defaults (themes recolor, never reflow), and the result is
  re-verified against every guarded pairing before it is returned. A custom
  theme is therefore the same kind of object a scraped one is, with the same
  guarantees, and there is no second implementation to keep in sync.

  Returns null only when a color is unreadable — which the filtered picker
  cannot produce, so it is a genuine backstop rather than a path users meet.
*/
export function buildCustomThemeVariation({
  name,
  roles,
  fonts,
  buttonShape,
  takenIds,
}: {
  name: string;
  roles: ThemeColorRoles;
  fonts: BrandKitFonts;
  buttonShape: ButtonShape;
  takenIds: string[];
}): ThemeVariation | null {
  const trimmedName = name.trim().length > 0 ? name.trim() : "Custom theme";
  const expanded = expandSemanticVariation({
    semantic: {
      name: trimmedName,
      emailBackgroundColor: deriveEmailBackgroundColor({
        contentBackground: roles.contentBackground,
        paragraphText: roles.paragraphText,
      }),
      contentBackgroundColor: roles.contentBackground,
      accentColor: roles.accent,
      headingTextColor: roles.headingText,
      paragraphTextColor: roles.paragraphText,
    },
    fonts,
    buttonShape,
  });
  if (expanded === null) {
    return null;
  }
  return {
    ...expanded,
    id: buildUniqueVariationId({ name: trimmedName, takenIds }),
    name: trimmedName,
  };
}

/* Renderer-default globals — the shape a preview falls back to before a pick. */
export function getFallbackPreviewGlobals(): Required<GlobalStyles> {
  return { ...DEFAULT_GLOBAL_STYLES };
}
