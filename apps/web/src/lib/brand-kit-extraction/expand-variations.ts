/**
 * Deterministic post-pass: expand the model's semantic color assignments into
 * COMPLETE `Required<GlobalStyles>` payloads (brand-kit.ts invariant — themes
 * recolor, never reflow), then ENFORCE WCAG-AA contrast on every guarded
 * pairing. The LLM is prompted to aim for contrast but is never trusted with
 * it: every foreground is verified with `getContrastRatio` and repaired here
 * (stepped toward black/white until compliant) rather than eyeballed.
 */

import { DEFAULT_GLOBAL_STYLES, type GlobalStyles } from "@flock/email-sdk";
import {
  getContrastRatio,
  getVariationContrastPairs,
  MIN_THEME_CONTRAST_RATIO,
  type BrandKitFonts,
  type ThemeVariation,
} from "@/lib/brand-kit";
import { mixHexColors, parseHexColor } from "./color-utils";

/** The model's per-variation output: semantic color roles, nothing layout. */
export interface SemanticVariation {
  name: string;
  emailBackgroundColor: string;
  contentBackgroundColor: string;
  /** Buttons (fill + border) and links take this color, contrast-repaired. */
  accentColor: string;
  headingTextColor: string;
  paragraphTextColor: string;
}

/** Intent-level button shape (LLM-facing) → concrete radius. */
export const BUTTON_SHAPE_RADII = {
  square: 0,
  rounded: 6,
  pill: 999,
} as const;

export type ButtonShape = keyof typeof BUTTON_SHAPE_RADII;

function ratioOf({ foreground, background }: { foreground: string; background: string }): number {
  return getContrastRatio({ foreground, background }) ?? 0;
}

/**
 * Repair a foreground color against a background: keep it if it already
 * passes, otherwise mix it stepwise toward whichever extreme (black/white)
 * reads better on this background. Pure black/white always satisfies 4.5:1
 * against any background (their ratios multiply to 21), so the loop always
 * terminates on a compliant color.
 */
export function repairForegroundContrast({
  foreground,
  background,
}: {
  foreground: string;
  background: string;
}): string {
  if (ratioOf({ foreground, background }) >= MIN_THEME_CONTRAST_RATIO) {
    return foreground;
  }
  const target =
    ratioOf({ foreground: "#000000", background }) >= ratioOf({ foreground: "#ffffff", background })
      ? "#000000"
      : "#ffffff";
  for (let amount = 0.05; amount < 1; amount += 0.05) {
    const candidate = mixHexColors({ base: foreground, target, amount });
    if (ratioOf({ foreground: candidate, background }) >= MIN_THEME_CONTRAST_RATIO) {
      return candidate;
    }
  }
  return target;
}

/**
 * Button label color: white or near-black, whichever reads better on the
 * fill. One of the two pure extremes always exceeds √21 ≈ 4.58:1; we prefer
 * the softer #111111 when it also clears the bar.
 */
function pickButtonLabelColor(buttonBackground: string): string {
  const whiteRatio = ratioOf({ foreground: "#ffffff", background: buttonBackground });
  const blackRatio = ratioOf({ foreground: "#000000", background: buttonBackground });
  if (whiteRatio >= blackRatio) {
    return "#ffffff";
  }
  const softBlackRatio = ratioOf({ foreground: "#111111", background: buttonBackground });
  return softBlackRatio >= MIN_THEME_CONTRAST_RATIO ? "#111111" : "#000000";
}

/** Subtle divider: paragraph color washed into the content background. */
function deriveDividerColor({
  contentBackgroundColor,
  paragraphTextColor,
}: {
  contentBackgroundColor: string;
  paragraphTextColor: string;
}): string {
  return mixHexColors({ base: contentBackgroundColor, target: paragraphTextColor, amount: 0.18 });
}

/**
 * Expand one semantic variation into a complete, contrast-enforced globals
 * payload. Returns null only when a color is unparseable (unrepairable) —
 * the pipeline drops that variation and keeps the rest.
 */
export function expandSemanticVariation({
  semantic,
  fonts,
  buttonShape,
}: {
  semantic: SemanticVariation;
  fonts: BrandKitFonts;
  buttonShape: ButtonShape;
}): ThemeVariation | null {
  const colorInputs = [
    semantic.emailBackgroundColor,
    semantic.contentBackgroundColor,
    semantic.accentColor,
    semantic.headingTextColor,
    semantic.paragraphTextColor,
  ];
  if (colorInputs.some((color) => parseHexColor(color) === null)) {
    return null;
  }

  const contentBg = semantic.contentBackgroundColor.toLowerCase();
  const accent = semantic.accentColor.toLowerCase();
  const headingColor = repairForegroundContrast({
    foreground: semantic.headingTextColor.toLowerCase(),
    background: contentBg,
  });
  const paragraphColor = repairForegroundContrast({
    foreground: semantic.paragraphTextColor.toLowerCase(),
    background: contentBg,
  });
  const linkColor = repairForegroundContrast({ foreground: accent, background: contentBg });
  const buttonTextColor = pickButtonLabelColor(accent);

  const globals: Required<GlobalStyles> = {
    // Layout keys stay at renderer defaults — themes recolor, never reflow.
    contentWidth: DEFAULT_GLOBAL_STYLES.contentWidth,
    baseSpacing: DEFAULT_GLOBAL_STYLES.baseSpacing,
    buttonBorderSize: DEFAULT_GLOBAL_STYLES.buttonBorderSize,
    buttonHorizontalPadding: DEFAULT_GLOBAL_STYLES.buttonHorizontalPadding,
    buttonVerticalPadding: DEFAULT_GLOBAL_STYLES.buttonVerticalPadding,
    // Image corner radius is brand-shapeable in principle (it is the image
    // counterpart of buttonBorderRadius), but nothing extracts an image shape
    // signal yet — so it holds the renderer default rather than guessing.
    imageBorderRadius: DEFAULT_GLOBAL_STYLES.imageBorderRadius,
    heading1TextAlign: DEFAULT_GLOBAL_STYLES.heading1TextAlign,
    heading2TextAlign: DEFAULT_GLOBAL_STYLES.heading2TextAlign,
    heading3TextAlign: DEFAULT_GLOBAL_STYLES.heading3TextAlign,
    paragraphTextAlign: DEFAULT_GLOBAL_STYLES.paragraphTextAlign,
    // Colors + fonts — the brand.
    emailBackgroundColor: semantic.emailBackgroundColor.toLowerCase(),
    contentBackgroundColor: contentBg,
    buttonBackgroundColor: accent,
    buttonTextColor,
    buttonBorderRadius: BUTTON_SHAPE_RADII[buttonShape],
    buttonBorderColor: accent,
    buttonFontFamily: fonts.body,
    heading1FontFamily: fonts.heading,
    heading1TextColor: headingColor,
    heading2FontFamily: fonts.heading,
    heading2TextColor: headingColor,
    heading3FontFamily: fonts.heading,
    heading3TextColor: headingColor,
    paragraphFontFamily: fonts.body,
    paragraphTextColor: paragraphColor,
    linkTextColor: linkColor,
    dividerColor: deriveDividerColor({
      contentBackgroundColor: contentBg,
      paragraphTextColor: paragraphColor,
    }),
  };

  const variation: ThemeVariation = {
    id: slugify(semantic.name),
    name: semantic.name,
    globals,
  };

  // Final verification with the contract's own helper — if anything still
  // fails (unparseable edge), the variation is dropped, never shipped broken.
  const hasFailingPair = getVariationContrastPairs(variation).some(
    (pair) => pair.ratio === null || pair.ratio < MIN_THEME_CONTRAST_RATIO,
  );
  return hasFailingPair ? null : variation;
}

/** "Warm Sand" → "warm-sand"; non-latin names fall back to a stable stub. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "variation";
}

