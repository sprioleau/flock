/**
 * Editable brand-kit fonts (brand-kit-v2 §1) — the pure rules behind the
 * panel's two font dropdowns and the `updateBrandFonts` mutation.
 *
 * Two decisions live here, and they are the whole feature:
 *
 * 1. **Selection, never free text.** A brand font is one of
 *    {@link EMAIL_SAFE_FONT_OPTIONS} — the SAME list the block property panel
 *    and the inline text tools use, so a font chosen anywhere resolves to the
 *    same stack. The dropdown is the UI half of that rule;
 *    {@link getBrandFontsValidationErrors} is the server half, so nothing but
 *    a real email-safe stack can ever land on the row.
 *
 *    (The scrape already obeys this: generate-brand-kit.ts constrains the
 *    model to the email-safe LABELS and maps them back to stacks, so an
 *    inferred font is email-safe before it is ever stored. The open question
 *    the proposal raised — snap at scrape time or keep the inferred value —
 *    was therefore already answered upstream. A legacy/mock kit carrying some
 *    other stack still renders: the dropdown shows it as a disabled "Custom"
 *    entry until the user picks a real one.)
 *
 * 2. **A font edit reaches the themes.** `variations[].globals` carries
 *    literal font stacks (expand-variations.ts built them FROM the kit's
 *    fonts), so changing `fonts.heading` while leaving the variations alone
 *    would be an edit that changes nothing anybody can see — the exact
 *    complaint §1 exists to fix. {@link applyBrandFontsToVariations} rewrites
 *    the font-family keys of every variation the same way the extraction
 *    pipeline assigns them.
 *
 *    This does NOT restyle existing drafts. Blocks and root globals store
 *    literal values; drafts change only through applyBrandToDocuments, which
 *    is somebody's explicit confirm (that is also why a font edit bumps
 *    `revision` — the drafts really are out of date with the kit now).
 */

import { EMAIL_SAFE_FONT_OPTIONS } from "../components/studio/text-editor/email-safe-fonts";
import type { BrandKitFonts, ThemeVariation } from "./brand-kit";

/*
  True when `stack` is one of the email-safe stacks, byte for byte.
*/
export function isEmailSafeFontStack(stack: string): boolean {
  return EMAIL_SAFE_FONT_OPTIONS.some((option) => option.value === stack);
}

/*
  Hard (blocking) problems with a fonts payload, as messages a person can
  act on. Empty array = valid. Shared by the panel and the Convex mutation,
  exactly like getBrandColorsValidationErrors.
*/
export function getBrandFontsValidationErrors(fonts: BrandKitFonts): string[] {
  const errors: string[] = [];
  const roles = [
    { label: "heading", stack: fonts.heading },
    { label: "body", stack: fonts.body },
  ];
  for (const role of roles) {
    if (role.stack.trim().length === 0) {
      errors.push(`Pick a ${role.label} font.`);
      continue;
    }
    if (!isEmailSafeFontStack(role.stack)) {
      errors.push(
        `That ${role.label} font isn't one we can send in email — pick one from the list.`,
      );
    }
  }
  return errors;
}

/*
  Re-font every variation from the kit's fonts, using the SAME role mapping
  the extraction pipeline uses (expand-variations.ts): headings 1–3 take the
  heading stack; paragraphs and button labels take the body stack. Colors,
  spacing and every other global are untouched — a font edit re-fonts, it
  never recolors or reflows.
*/
export function applyBrandFontsToVariations({
  variations,
  fonts,
}: {
  variations: ThemeVariation[];
  fonts: BrandKitFonts;
}): ThemeVariation[] {
  return variations.map((variation) => ({
    ...variation,
    globals: {
      ...variation.globals,
      heading1FontFamily: fonts.heading,
      heading2FontFamily: fonts.heading,
      heading3FontFamily: fonts.heading,
      paragraphFontFamily: fonts.body,
      buttonFontFamily: fonts.body,
    },
  }));
}
