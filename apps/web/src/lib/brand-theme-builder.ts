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

  The edit FORM's decision logic now lives here too (§14.5b):
  {@link getThemeColorRoles} reads a stored theme back into the four roles,
  {@link getThemeEditPaletteHexes} is why its own colors are always on offer,
  and {@link buildEditedThemeVariation} composes the payload the existing
  mutation is called with. Contrast filtering applies to an edit exactly as it
  applies to an add — same eligible sets, same selects, same guarantee that a
  combination on screen is a combination that saves.

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

/*
  The four roles read BACK out of a stored variation — the inverse of
  {@link buildCustomThemeVariation}'s expansion, and what seeds the edit form.

  It reads the four keys the user picked and nothing else. The rest of the
  payload (email background, divider, button label, repaired link color) is
  DERIVED from these four, so re-deriving them is how an edit stays the same
  kind of object an add produces: one expander, one set of guarantees, no
  second implementation of "what a theme is".
*/
export function getThemeColorRoles(variation: ThemeVariation): ThemeColorRoles {
  return {
    contentBackground: variation.globals.contentBackgroundColor,
    headingText: variation.globals.heading1TextColor,
    paragraphText: variation.globals.paragraphTextColor,
    accent: variation.globals.buttonBackgroundColor,
  };
}

/*
  The colors the EDIT form may offer: the kit's palette plus the four this
  theme already uses.

  Without the union, editing a scraped theme would be a trap. Scraped
  variations are expanded from the model's semantic picks and contrast-repaired
  (expand-variations.ts), so their heading or paragraph color is frequently a
  repaired shade that is not in the authored palette at all — and a select whose
  option list does not contain its own current value shows the wrong color
  selected and silently changes the theme the moment it is submitted.

  Adding the theme's own colors keeps filter-before-offering exactly as strong.
  The stored combination already passes WCAG-AA (nothing else is ever written to
  a kit row), so admitting those four colors cannot admit a failing pair — it
  guarantees the current one is on offer, which is the minimum an edit form has
  to promise.
*/
export function getThemeEditPaletteHexes({
  paletteHexes,
  roles,
}: {
  paletteHexes: string[];
  roles: ThemeColorRoles;
}): string[] {
  const merged = [...paletteHexes];
  const seen = new Set(paletteHexes);
  const roleHexes = [roles.contentBackground, roles.headingText, roles.paragraphText, roles.accent];
  for (const hex of roleHexes) {
    const normalized = normalizeHex(hex);
    if (normalized === null || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    merged.push(normalized);
  }
  return merged;
}

/** True when two role sets name the same color for every role. */
export function areThemeColorRolesEqual({
  a,
  b,
}: {
  a: ThemeColorRoles;
  b: ThemeColorRoles;
}): boolean {
  return (
    normalizeHex(a.contentBackground) === normalizeHex(b.contentBackground) &&
    normalizeHex(a.headingText) === normalizeHex(b.headingText) &&
    normalizeHex(a.paragraphText) === normalizeHex(b.paragraphText) &&
    normalizeHex(a.accent) === normalizeHex(b.accent)
  );
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

  `existingId` is the EDIT path's one difference (§14.5b). A theme's id is what
  every draft pointer names, so an edit must keep it byte for byte — deriving a
  fresh slug from the new name would silently strand every draft that was an
  instance of this theme, which is the deletion behaviour, arrived at by
  renaming. Keeping the id is also what makes `updateBrandThemeVariation`'s
  "a pure rename does not bump the revision" rule reachable from the UI at all.
*/
export function buildCustomThemeVariation({
  name,
  roles,
  fonts,
  buttonShape,
  takenIds,
  existingId,
}: {
  name: string;
  roles: ThemeColorRoles;
  fonts: BrandKitFonts;
  buttonShape: ButtonShape;
  takenIds: string[];
  existingId?: string;
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
    id: existingId ?? buildUniqueVariationId({ name: trimmedName, takenIds }),
    name: trimmedName,
  };
}

/*
  The EDIT form's payload: this theme, with the name and colors the user now
  wants (§14.5b — the UI half of `updateBrandThemeVariation`, which already
  shipped).

  UNCHANGED COLORS KEEP THE STORED PAYLOAD VERBATIM, and that is the whole
  reason this is a function rather than a call to the builder above. The
  expander DERIVES the email background, the divider, the button label and the
  repaired link color from the four roles, so re-expanding a scraped theme
  whose author picked a different email background would rewrite those keys —
  and a user who only retyped the NAME would get a payload edit, a revision
  bump, and an "Updated brand available" pill on every draft using it, for a
  change nobody made. Comparing the roles first makes a rename a rename.

  Returns null only when the expander refuses a color, the same backstop the
  add path has.
*/
export function buildEditedThemeVariation({
  variation,
  name,
  roles,
  fonts,
}: {
  variation: ThemeVariation;
  name: string;
  roles: ThemeColorRoles;
  fonts: BrandKitFonts;
}): ThemeVariation | null {
  const trimmedName = name.trim().length > 0 ? name.trim() : variation.name;
  if (areThemeColorRolesEqual({ a: roles, b: getThemeColorRoles(variation) })) {
    return { ...variation, name: trimmedName };
  }
  return buildCustomThemeVariation({
    name: trimmedName,
    roles,
    fonts,
    /*
      THIS theme's shape, not the kit's. `BrandKitPanel` passes the kit-wide
      shape (read off the first variation) to the ADD form, which is right for
      a brand new theme; using it here would square off the pill buttons of the
      one variation whose author chose them, on an edit that only touched color.
    */
    buttonShape: getButtonShapeFromRadius(variation.globals.buttonBorderRadius),
    takenIds: [],
    existingId: variation.id,
  });
}

/* Renderer-default globals — the shape a preview falls back to before a pick. */
export function getFallbackPreviewGlobals(): Required<GlobalStyles> {
  return { ...DEFAULT_GLOBAL_STYLES };
}
